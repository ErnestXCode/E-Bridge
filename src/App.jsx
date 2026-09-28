import { memo, useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const PAGE_GAP = 28;
const DEFAULT_PAGE_WIDTH = 820;
const PAGE_BUFFER = 2;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

/* ============================================================
   HELPERS
============================================================ */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function median(values) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

/* ============================================================
   PDF TEXT
============================================================ */

function normalizeItems(items) {
  return items
    .filter((item) => item.str && item.str.trim())
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width || 0,
      height: item.height || Math.abs(item.transform[3]) || 10,
    }));
}

/* ============================================================
   ROW DETECTION
============================================================ */

function buildRows(items) {
  if (!items.length) return [];

  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 5) {
      return b.y - a.y;
    }

    return a.x - b.x;
  });

  const rows = [];

  for (const item of sorted) {
    const itemCenter = item.y + item.height / 2;

    let bestRow = null;
    let bestDistance = Infinity;

    for (const row of rows) {
      const distance = Math.abs(row.center - itemCenter);

      if (distance <= 5 && distance < bestDistance) {
        bestRow = row;
        bestDistance = distance;
      }
    }

    if (bestRow) {
      bestRow.items.push(item);

      bestRow.center =
        (bestRow.center * (bestRow.items.length - 1) + itemCenter) /
        bestRow.items.length;
    } else {
      rows.push({
        center: itemCenter,
        items: [item],
      });
    }
  }

  return rows
    .sort((a, b) => b.center - a.center)
    .map((row) => [...row.items].sort((a, b) => a.x - b.x));
}

/* ============================================================
   MERGE PDF FRAGMENTS
============================================================ */

function mergeRowFragments(row) {
  if (!row.length) return [];

  const cells = [];

  for (const item of row) {
    const previous = cells[cells.length - 1];

    if (!previous) {
      cells.push({
        text: item.text,
        x: item.x,
        width: item.width,
        right: item.x + item.width,
        y: item.y,
        height: item.height,
      });

      continue;
    }

    const gap = item.x - previous.right;

    if (gap >= 0 && gap < 18) {
      previous.text += ` ${item.text}`;
      previous.right = Math.max(
        previous.right,
        item.x + item.width,
      );
      previous.width =
        previous.right - previous.x;
      previous.height = Math.max(
        previous.height,
        item.height,
      );
    } else {
      cells.push({
        text: item.text,
        x: item.x,
        width: item.width,
        right: item.x + item.width,
        y: item.y,
        height: item.height,
      });
    }
  }

  return cells;
}

/* ============================================================
   NUMERIC DETECTION
============================================================ */

function isNumericText(text) {
  const trimmed = text.trim();

  if (!trimmed) return false;

  /*
    Dash / em dash / hyphen are treated as financial values.
  */
  if (/^[-–—]+$/.test(trimmed)) {
    return true;
  }

  /*
    PDF extraction occasionally produces ###.
  */
  if (/^#+$/.test(trimmed)) {
    return true;
  }

  /*
    Remove common financial formatting:
      commas
      parentheses
      %
      plus/minus
      spaces
  */
  const stripped = trimmed
    .replace(/\s+/g, "")
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .replace(/,/g, "")
    .replace(/^[-+]/, "")
    .replace(/%$/, "")
    .trim();

  /*
    Examples accepted:
      1
      1.5
      1,500
      (1,500)
      12%
      -500
      2025
  */
  return /^\d+(\.\d+)?$/.test(stripped);
}

/* ============================================================
   FINANCIAL VALUE NORMALIZATION
============================================================ */

function normalizeFinancialValue(text) {
  const value = text
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ")
    .trim();

  if (!value) return "";

  if (/^[-–—]+$/.test(value)) {
    return "0";
  }

  return value;
}

/* ============================================================
   NUMERIC COLUMN DETECTION
============================================================ */

/*
  Financial reports are highly repetitive.

  The important signal is not every individual cell boundary.
  It is the repeated horizontal position of numbers.

  Most financial statements right-align their numbers, so the
  RIGHT edge of numeric cells is a particularly useful anchor.

  Example:

       Revenue                 2025       2024       2023
       Cost of sales           8,000      7,500      7,000
       Gross profit            4,000      3,800      3,500

  The right edges of 2025 / 2024 / 2023 and the values beneath
  them repeatedly establish the numeric columns.

  A single badly extracted number does NOT get to create a new
  column.
*/

function clusterNumericAnchors(values, tolerance = 10) {
  if (!values.length) return [];

  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];

  for (const value of sorted) {
    const last = clusters[clusters.length - 1];

    if (
      last &&
      Math.abs(value - last.center) <= tolerance
    ) {
      last.values.push(value);

      last.center =
        last.values.reduce(
          (sum, current) => sum + current,
          0,
        ) / last.values.length;
    } else {
      clusters.push({
        values: [value],
        center: value,
      });
    }
  }

  return clusters.map((cluster) => ({
    center: cluster.center,
    support: cluster.values.length,
  }));
}

/*
  Some PDF files have slightly different x positions for
  numbers in different rows because of font rendering.

  We therefore use several signals:

    1. numeric right edge
    2. numeric center
    3. repeated support across rows

  Right-edge clusters are the primary anchors.
*/

function getNumericCells(rows) {
  const numericCells = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    for (const cell of rows[rowIndex]) {
      if (!isNumericText(cell.text)) {
        continue;
      }

      const right =
        cell.right ??
        cell.x + cell.width;

      const center =
        cell.x + cell.width / 2;

      numericCells.push({
        rowIndex,
        cell,
        right,
        center,
      });
    }
  }

  return numericCells;
}

function buildNumericColumns(rows) {
  const numericCells = getNumericCells(rows);

  if (!numericCells.length) {
    return [];
  }

  /*
    Right-edge clustering is the main method.
  */
  const rightClusters =
    clusterNumericAnchors(
      numericCells.map((item) => item.right),
      10,
    );

  /*
    Ignore completely isolated numeric positions when there
    is enough evidence for a repeated table structure.

    We still allow support of 1 when the entire table is tiny.
  */
  const rowCount = rows.length;

  const minimumSupport =
    rowCount >= 8
      ? 2
      : 1;

  let anchors = rightClusters.filter(
    (cluster) =>
      cluster.support >= minimumSupport,
  );

  /*
    If filtering removed too much, fall back to all clusters.
  */
  if (anchors.length < 2) {
    anchors = rightClusters;
  }

  /*
    Sort left-to-right.
  */
  anchors.sort(
    (a, b) => a.center - b.center,
  );

  /*
    Remove duplicate / near-identical anchors.
  */
  const cleaned = [];

  for (const anchor of anchors) {
    const previous =
      cleaned[cleaned.length - 1];

    if (
      previous &&
      Math.abs(
        anchor.center -
          previous.center,
      ) <= 12
    ) {
      const totalSupport =
        previous.support +
        anchor.support;

      previous.center =
        (
          previous.center *
            previous.support +
          anchor.center *
            anchor.support
        ) / totalSupport;

      previous.support = totalSupport;
    } else {
      cleaned.push({
        center: anchor.center,
        support: anchor.support,
      });
    }
  }

  /*
    A financial table normally has sequential numeric columns.

    If there are large gaps, we do NOT manufacture columns.
    We only use positions that are actually supported by the PDF.
  */
  return cleaned;
}

/*
  Convert numeric anchors into column objects.

  Column 0 is reserved for the textual label area.

  Numeric columns are represented by their anchor x-position.
*/
function buildColumns(rows) {
  const numericAnchors =
    buildNumericColumns(rows);

  if (!numericAnchors.length) {
    return [];
  }

  const columns = [
    {
      type: "label",
      index: 0,
      center: 0,
      left: -Infinity,
      right:
        numericAnchors[0].center,
    },
  ];

  for (
    let i = 0;
    i < numericAnchors.length;
    i++
  ) {
    const current =
      numericAnchors[i];

    const previous =
      numericAnchors[i - 1];

    const next =
      numericAnchors[i + 1];

    let left;

    let right;

    if (previous) {
      left =
        (
          previous.center +
          current.center
        ) / 2;
    } else {
      left = -Infinity;
    }

    if (next) {
      right =
        (
          current.center +
          next.center
        ) / 2;
    } else {
      right = Infinity;
    }

    columns.push({
      type: "numeric",
      index: i + 1,
      center: current.center,
      left,
      right,
      support: current.support,
    });
  }

  return columns;
}

/* ============================================================
   ROW STRUCTURE
============================================================ */

/*
  Assign a numeric cell to the numeric column whose established
  anchor is closest to the cell's RIGHT edge.

  This is deliberately different from the old overlap method.

  The established column wins.

  Blank rows/cells do not affect the column structure.
*/

function getNearestNumericColumn(
  cell,
  numericColumns,
) {
  if (!numericColumns.length) {
    return -1;
  }

  const right =
    cell.right ??
    cell.x + cell.width;

  let bestIndex = -1;
  let bestDistance = Infinity;

  for (
    let i = 0;
    i < numericColumns.length;
    i++
  ) {
    const column =
      numericColumns[i];

    const distance =
      Math.abs(
        right - column.center,
      );

    if (
      distance < bestDistance
    ) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex;
}

/*
  When a numeric cell is slightly displaced, compare it with the
  surrounding rows.

  Example:

       row above     2025   2024   2023
       current       value
       row below     2025   2024   2023

  If the current value is closer to the 2024 position because of
  PDF extraction noise, but the neighbouring rows clearly use
  2025 at that position, the established sequence wins.
*/

function getNeighborColumnEvidence(
  assignments,
  rowIndex,
  columnIndex,
) {
  let evidence = 0;

  const previous =
    assignments[rowIndex - 1];

  const next =
    assignments[rowIndex + 1];

  if (
    previous &&
    previous.some(
      (item) =>
        item.numericColumn ===
        columnIndex,
    )
  ) {
    evidence += 1;
  }

  if (
    next &&
    next.some(
      (item) =>
        item.numericColumn ===
        columnIndex,
    )
  ) {
    evidence += 1;
  }

  return evidence;
}

/*
  Correct obvious one-column shifts.

  Important:

  We DO NOT move every number toward the left.

  We only move a number when:

    - its current position is weak
    - another established column is nearby
    - that target column has repeated support
    - the target is supported by neighbouring rows
    - the target column is empty on the current row

  This means normal sparse financial rows remain sparse.
*/

function repairNumericAssignments(
  assignments,
  numericColumns,
) {
  if (
    !assignments.length ||
    numericColumns.length <= 1
  ) {
    return assignments;
  }

  const rowCount =
    assignments.length;

  const support =
    Array(numericColumns.length).fill(0);

  /*
    Measure support using distinct rows.
  */
  for (const row of assignments) {
    const seen = new Set();

    for (const item of row) {
      if (
        item.numericColumn !== null &&
        item.numericColumn >= 0
      ) {
        seen.add(
          item.numericColumn,
        );
      }
    }

    for (const column of seen) {
      support[column] += 1;
    }
  }

  /*
    Copy the original structure.

    Neighbour evidence should come from the original PDF
    reconstruction, not from corrections we make later.
  */
  const original =
    assignments.map((row) =>
      row.map((item) => ({
        ...item,
      })),
    );

  const repaired =
    assignments.map((row) =>
      row.map((item) => ({
        ...item,
      })),
    );

  /*
    Occupancy is mutable because after moving a value we need
    to prevent another value from moving into the same cell.
  */
  const occupied =
    repaired.map(
      (row) =>
        new Set(
          row
            .filter(
              (item) =>
                item.numericColumn !== null &&
                item.numericColumn >= 0,
            )
            .map(
              (item) =>
                item.numericColumn,
            ),
        ),
    );

  /*
    Strong structural support.

    A column appearing in 20%+ of rows is normally meaningful,
    but we always require at least 3 rows for larger selections.
  */
  const strongSupport =
    Math.max(
      3,
      Math.ceil(rowCount * 0.2),
    );

  /*
    Typical spacing between established numeric columns.
  */
  const gaps = [];

  for (
    let i = 1;
    i < numericColumns.length;
    i++
  ) {
    const gap =
      numericColumns[i].center -
      numericColumns[i - 1].center;

    if (gap > 5) {
      gaps.push(gap);
    }
  }

  const typicalSpacing =
    median(gaps) || 40;

  /*
    Only repair local shifts.

    If something is two or three columns away, it is much more
    likely to be a genuinely different structure.
  */
  const maxShift =
    typicalSpacing * 1.25;

  for (
    let rowIndex = 0;
    rowIndex < repaired.length;
    rowIndex++
  ) {
    const row =
      repaired[rowIndex];

    for (
      let itemIndex = 0;
      itemIndex < row.length;
      itemIndex++
    ) {
      const assignment =
        row[itemIndex];

      if (
        !isNumericText(
          assignment.cell.text,
        )
      ) {
        continue;
      }

      const source =
        assignment.numericColumn;

      if (
        source === null ||
        source < 0
      ) {
        continue;
      }

      const sourceSupport =
        support[source];

      const sourceNeighbors =
        getNeighborColumnEvidence(
          original,
          rowIndex,
          source,
        );

      /*
        If the current column is already repeatedly established
        and neighbouring rows agree with it, there is no reason
        to move the value.
      */
      if (
        sourceSupport >=
          strongSupport &&
        sourceNeighbors >= 1
      ) {
        continue;
      }

      const cellRight =
        assignment.cell.right ??
        assignment.cell.x +
          assignment.cell.width;

      let bestTarget = -1;
      let bestScore = -Infinity;

      for (
        let target = 0;
        target <
        numericColumns.length;
        target++
      ) {
        if (target === source) {
          continue;
        }

        /*
          Never overwrite another number on the same row.
        */
        if (
          occupied[rowIndex].has(
            target,
          )
        ) {
          continue;
        }

        const targetSupport =
          support[target];

        /*
          The target needs real repeated evidence.
        */
        if (
          targetSupport <
          strongSupport
        ) {
          continue;
        }

        /*
          It should be materially stronger than the current
          position. This protects sparse legitimate columns.
        */
        if (
          targetSupport <
          sourceSupport + 2
        ) {
          continue;
        }

        const distance =
          Math.abs(
            cellRight -
              numericColumns[
                target
              ].center,
          );

        if (
          distance >
          maxShift
        ) {
          continue;
        }

        const neighborEvidence =
          getNeighborColumnEvidence(
            original,
            rowIndex,
            target,
          );

        /*
          Target scoring:

          repeated support is the main signal
          neighbouring rows are stronger evidence
          left-shift gets a small preference because this is
          the common PDF extraction error we are correcting
        */
        let score =
          targetSupport * 2 +
          neighborEvidence * 8 -
          (distance /
            typicalSpacing) *
            2;

        if (
          target < source
        ) {
          score += 3;
        }

        if (
          neighborEvidence ===
          2
        ) {
          score += 5;
        }

        /*
          Compare against keeping the current position.
        */
        const sourceScore =
          sourceSupport * 2 +
          sourceNeighbors * 8;

        /*
          Require meaningful evidence before changing anything.
        */
        if (
          score <=
          sourceScore + 5
        ) {
          continue;
        }

        if (
          score > bestScore
        ) {
          bestScore = score;
          bestTarget = target;
        }
      }

      if (
        bestTarget === -1
      ) {
        continue;
      }

      /*
        Move the value.

        The original structural evidence is not modified, so
        later repairs cannot create fake evidence for themselves.
      */
      occupied[rowIndex].delete(
        source,
      );

      occupied[rowIndex].add(
        bestTarget,
      );

      assignment.numericColumn =
        bestTarget;
    }
  }

  return repaired;
}

/* ============================================================
   TABLE ASSIGNMENT
============================================================ */

function assignCellsToColumns(
  rows,
  columns,
) {
  if (
    !rows.length ||
    !columns.length
  ) {
    return rows.map((row) =>
      row.map((cell) => ({
        text: cell.text,
        x: cell.x,
        width: cell.width,
      })),
    );
  }

  /*
    Column 0 is always the textual label column.
    Everything numeric is assigned to one of the established
    numeric columns.
  */
  const numericColumns =
    columns.filter(
      (column) =>
        column.type ===
        "numeric",
    );

  if (!numericColumns.length) {
    return rows.map((row) =>
      row.map((cell) => ({
        text: cell.text,
        x: cell.x,
        width: cell.width,
      })),
    );
  }

  /*
    Initial assignment.

    Text stays on the left.

    Numeric cells are mapped to the nearest established
    numeric anchor.
  */
  const assignments =
    rows.map((row) => {
      const output = [];

      for (const cell of row) {
        if (
          isNumericText(cell.text)
        ) {
          const numericColumn =
            getNearestNumericColumn(
              cell,
              numericColumns,
            );

          output.push({
            cell,
            numericColumn,
          });
        } else {
          output.push({
            cell,
            numericColumn: null,
          });
        }
      }

      return output;
    });

  /*
    Structural correction.

    This is where we tolerate blanks and use the repeated
    vertical pattern of the report.
  */
  const repaired =
    repairNumericAssignments(
      assignments,
      numericColumns,
    );

  /*
    Build rectangular output.

    Column 0 = labels/text.

    Column 1+ = established numeric columns.
  */
  return repaired.map(
    (row) => {
      const output = Array(
        numericColumns.length + 1,
      ).fill(null);

      /*
        All text fragments belong to the label column.
      */
      const textCells =
        row.filter(
          (item) =>
            item.numericColumn ===
            null,
        );

      if (textCells.length) {
        const first =
          textCells[0];

        let left = first.cell.x;

        let right =
          first.cell.x +
          first.cell.width;

        let text =
          first.cell.text;

        for (
          let i = 1;
          i < textCells.length;
          i++
        ) {
          const current =
            textCells[i].cell;

          text += ` ${current.text}`;

          left = Math.min(
            left,
            current.x,
          );

          right = Math.max(
            right,
            current.x +
              current.width,
          );
        }

        output[0] = {
          text,
          x: left,
          width: right - left,
        };
      }

      /*
        Numeric values occupy their established column.
      */
      for (const assignment of row) {
        if (
          assignment.numericColumn ===
          null
        ) {
          continue;
        }

        const target =
          assignment.numericColumn +
          1;

        const cell =
          assignment.cell;

        if (!output[target]) {
          output[target] = {
            text: cell.text,
            x: cell.x,
            width: cell.width,
          };
        } else {
          /*
            This should be rare, but if two PDF fragments land
            in the same established column, preserve both.
          */
          const existing =
            output[target];

          const left =
            Math.min(
              existing.x,
              cell.x,
            );

          const right =
            Math.max(
              existing.x +
                existing.width,
              cell.x +
                cell.width,
            );

          output[target] = {
            text: `${existing.text} ${cell.text}`,
            x: left,
            width:
              right - left,
          };
        }
      }

      return output;
    },
  );
}

/* ============================================================
   TABLE MODEL
============================================================ */

function buildCells(items) {
  if (!items.length) return [];

  const rawRows =
    buildRows(items);

  const mergedRows =
    rawRows.map(
      mergeRowFragments,
    );

  if (!mergedRows.length) {
    return [];
  }

  /*
    New table reconstruction.

    We no longer build columns from every PDF text edge.

    Instead:

      text → label column
      repeated numeric positions → numeric columns
      blank → blank
  */
  const columns =
    buildColumns(mergedRows);

  if (
    columns.length <= 1
  ) {
    return mergedRows.map(
      (row) =>
        row.map((cell) => ({
          text: cell.text,
          x: cell.x,
          width: cell.width,
        })),
    );
  }

  return assignCellsToColumns(
    mergedRows,
    columns,
  ).map((row) =>
    row.map((cell) =>
      cell
        ? {
            text: cell.text,
            x: cell.x,
            width: cell.width,
          }
        : {
            text: "",
            x: 0,
            width: 0,
          },
    ),
  );
}

/* ============================================================
   EXCEL OUTPUT
============================================================ */

function convertItemsToExcel(items) {
  const rows =
    buildCells(items);

  return rows
    .map((row) =>
      row
        .map((cell) =>
          normalizeFinancialValue(
            cell?.text || "",
          ),
        )
        .join("\t"),
    )
    .join("\n");
}

/* ============================================================
   APP
============================================================ */

function App() {
  const [pdf, setPdf] =
    useState(null);

  const [fileName, setFileName] =
    useState("");

  const [pageNumber, setPageNumber] =
    useState(1);

  const [numPages, setNumPages] =
    useState(0);

  const [viewMode, setViewMode] =
    useState("continuous");

  const [
    selectionMode,
    setSelectionMode,
  ] = useState(false);

  const [zoom, setZoom] =
    useState(1);

  const [loading, setLoading] =
    useState(false);

  const [error, setError] =
    useState("");

  const [pageRatio, setPageRatio] =
    useState(1.414);

  const pageCacheRef =
    useRef(new Map());

  const pageTextCacheRef =
    useRef(new Map());

  const pageDataCacheRef =
    useRef(new Map());

  const renderedPageCacheRef =
    useRef(new Map());

  const renderPromiseCacheRef =
    useRef(new Map());

  const renderTaskCacheRef =
    useRef(new Map());

  const documentVersionRef =
    useRef(0);

  const [selection, setSelection] =
    useState(null);

  const [dragging, setDragging] =
    useState(false);

  const dragStartRef =
    useRef(null);

  const [copyMessage, setCopyMessage] =
    useState("");

  const [copyState, setCopyState] =
    useState("idle");

  const [
    toolbarPinned,
    setToolbarPinned,
  ] = useState(false);

  const fileInputRef =
    useRef(null);

  const viewerRef =
    useRef(null);

  const singleCanvasRef =
    useRef(null);

  const renderTokenRef =
    useRef(0);

  const scrollFrameRef =
    useRef(null);

  const lastScrollPageRef =
    useRef(1);

  const [singlePageData, setSinglePageData] =
    useState(null);

  const copyMessageTimerRef =
    useRef(null);

  const copyStateTimerRef =
    useRef(null);

  const pageWidth =
    DEFAULT_PAGE_WIDTH * zoom;

  const pageHeight =
    pageWidth * pageRatio;

  const documentHeight =
    numPages > 0
      ? numPages * pageHeight +
        Math.max(
          0,
          numPages - 1,
        ) *
          PAGE_GAP
      : pageHeight;

  /* ==========================================================
     CACHE CLEANUP
  ========================================================== */

  const cancelRenderTasks =
    useCallback(() => {
      for (const task of renderTaskCacheRef.current.values()) {
        try {
          task.cancel();
        } catch {}
      }

      renderTaskCacheRef.current.clear();
    }, []);

  const clearRenderedPageCache =
    useCallback(() => {
      cancelRenderTasks();

      for (const cached of renderedPageCacheRef.current.values()) {
        try {
          if (
            cached?.canvas &&
            typeof cached.canvas.width ===
              "number"
          ) {
            cached.canvas.width = 1;
            cached.canvas.height = 1;
          }
        } catch {}
      }

      renderedPageCacheRef.current.clear();
      renderPromiseCacheRef.current.clear();
    }, [cancelRenderTasks]);

  /* ==========================================================
     PDF EFFECTS
  ========================================================== */

  useEffect(() => {
    if (!pdf) return;

    if (viewMode === "single") {
      renderSinglePage(
        pageNumber,
        true,
      );
    }
  }, [pdf]);

  useEffect(() => {
    if (!pdf) return;

    if (viewMode === "single") {
      renderSinglePage(
        pageNumber,
        false,
      );
    }
  }, [
    pageNumber,
    viewMode,
    zoom,
  ]);

  useEffect(() => {
    if (!pdf) return;

    clearRenderedPageCache();
  }, [
    zoom,
    clearRenderedPageCache,
  ]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current) {
        cancelAnimationFrame(
          scrollFrameRef.current,
        );
      }

      if (
        copyMessageTimerRef.current
      ) {
        clearTimeout(
          copyMessageTimerRef.current,
        );
      }

      if (
        copyStateTimerRef.current
      ) {
        clearTimeout(
          copyStateTimerRef.current,
        );
      }

      clearRenderedPageCache();

      if (pdf) {
        try {
          pdf.destroy();
        } catch {}
      }
    };
  }, []);

  /* ==========================================================
     SCROLL TRACKING
  ========================================================== */

  useEffect(() => {
    if (
      !pdf ||
      viewMode !== "continuous"
    ) {
      return;
    }

    const handleScroll = () => {
      if (scrollFrameRef.current) {
        return;
      }

      scrollFrameRef.current =
        requestAnimationFrame(() => {
          scrollFrameRef.current =
            null;

          const viewer =
            viewerRef.current;

          if (!viewer) return;

          const viewerTop =
            viewer.getBoundingClientRect()
              .top +
            window.scrollY;

          const readingPoint =
            window.scrollY +
            window.innerHeight *
              0.42;

          const relativeReadingPoint =
            readingPoint -
            viewerTop;

          const slotHeight =
            pageHeight +
            PAGE_GAP;

          const nextPage = clamp(
            Math.floor(
              Math.max(
                0,
                relativeReadingPoint -
                  28,
              ) /
                slotHeight,
            ) + 1,
            1,
            numPages,
          );

          if (
            nextPage !==
            lastScrollPageRef.current
          ) {
            lastScrollPageRef.current =
              nextPage;

            setPageNumber(
              nextPage,
            );
          }
        });
    };

    window.addEventListener(
      "scroll",
      handleScroll,
      {
        passive: true,
      },
    );

    handleScroll();

    return () => {
      window.removeEventListener(
        "scroll",
        handleScroll,
      );

      if (
        scrollFrameRef.current
      ) {
        cancelAnimationFrame(
          scrollFrameRef.current,
        );

        scrollFrameRef.current =
          null;
      }
    };
  }, [
    pdf,
    viewMode,
    pageHeight,
    numPages,
  ]);

  /* ==========================================================
     PAGE CACHE
  ========================================================== */

  const getPage =
    useCallback(
      async (pageNum) => {
        if (!pdf) return null;

        const cached =
          pageCacheRef.current.get(
            pageNum,
          );

        if (cached) {
          return cached;
        }

        const page =
          await pdf.getPage(
            pageNum,
          );

        const viewport =
          page.getViewport({
            scale: 1,
          });

        const result = {
          page,
          width: viewport.width,
          height: viewport.height,
          ratio:
            viewport.height /
            viewport.width,
        };

        pageCacheRef.current.set(
          pageNum,
          result,
        );

        return result;
      },
      [pdf],
    );

  const getPageText =
    useCallback(
      async (pageNum) => {
        const cached =
          pageTextCacheRef.current.get(
            pageNum,
          );

        if (cached) {
          return cached;
        }

        const result =
          await getPage(pageNum);

        if (!result) return [];

        try {
          const content =
            await result.page.getTextContent();

          const items =
            normalizeItems(
              content.items,
            );

          pageTextCacheRef.current.set(
            pageNum,
            items,
          );

          return items;
        } catch (err) {
          console.error(err);
          return [];
        }
      },
      [getPage],
    );

  /* ==========================================================
     OPEN PDF
  ========================================================== */

  async function openFile(file) {
    if (!file) return;

    documentVersionRef.current += 1;

    setLoading(true);
    setError("");
    setSelection(null);
    setCopyMessage("");
    setCopyState("idle");
    setSinglePageData(null);
    setSelectionMode(false);

    clearRenderedPageCache();

    pageCacheRef.current.clear();
    pageTextCacheRef.current.clear();
    pageDataCacheRef.current.clear();

    renderTokenRef.current += 1;

    if (pdf) {
      try {
        await pdf.destroy();
      } catch {}
    }

    try {
      const buffer =
        await file.arrayBuffer();

      const loadingTask =
        pdfjsLib.getDocument({
          data: buffer,
        });

      const loadedPdf =
        await loadingTask.promise;

      setPdf(loadedPdf);
      setFileName(file.name);
      setNumPages(
        loadedPdf.numPages,
      );

      setPageNumber(1);
      lastScrollPageRef.current =
        1;

      const firstPage =
        await loadedPdf.getPage(
          1,
        );

      const viewport =
        firstPage.getViewport({
          scale: 1,
        });

      const ratio =
        viewport.height /
        viewport.width;

      setPageRatio(ratio);

      pageCacheRef.current.set(
        1,
        {
          page: firstPage,
          width: viewport.width,
          height: viewport.height,
          ratio,
        },
      );

      requestAnimationFrame(() => {
        window.scrollTo({
          top: 0,
          behavior: "auto",
        });
      });
    } catch (err) {
      console.error(err);
      setError(
        "Could not open this PDF.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleFileChange(
    event,
  ) {
    const file =
      event.target.files?.[0];

    if (file) {
      openFile(file);
    }

    event.target.value = "";
  }

  /* ==========================================================
     ZOOM
  ========================================================== */

  function changeZoom(delta) {
    setZoom((current) =>
      clamp(
        Number(
          (
            current + delta
          ).toFixed(2),
        ),
        MIN_ZOOM,
        MAX_ZOOM,
      ),
    );
  }

  function resetZoom() {
    setZoom(1);
  }

  /* ==========================================================
     OFFSCREEN PAGE RENDER
  ========================================================== */

  const getRenderedPage =
    useCallback(
      async (pageNum) => {
        if (!pdf) return null;

        const documentVersion =
          documentVersionRef.current;

        const cacheKey = `${pageNum}@${Math.round(
          pageWidth,
        )}`;

        const cached =
          renderedPageCacheRef.current.get(
            cacheKey,
          );

        if (cached) {
          return cached;
        }

        const existingPromise =
          renderPromiseCacheRef.current.get(
            cacheKey,
          );

        if (existingPromise) {
          return existingPromise;
        }

        const renderPromise =
          (async () => {
            const result =
              await getPage(
                pageNum,
              );

            if (!result) {
              return null;
            }

            if (
              documentVersion !==
              documentVersionRef.current
            ) {
              return null;
            }

            const scale =
              pageWidth /
              result.width;

            const viewport =
              result.page.getViewport({
                scale,
              });

            const outputScale =
              window.devicePixelRatio ||
              1;

            const renderCanvas =
              document.createElement(
                "canvas",
              );

            renderCanvas.width =
              Math.ceil(
                viewport.width *
                  outputScale,
              );

            renderCanvas.height =
              Math.ceil(
                viewport.height *
                  outputScale,
              );

            const context =
              renderCanvas.getContext(
                "2d",
                {
                  alpha: false,
                },
              );

            if (!context) {
              throw new Error(
                "Could not create canvas context.",
              );
            }

            context.setTransform(
              outputScale,
              0,
              0,
              outputScale,
              0,
              0,
            );

            context.fillStyle =
              "#ffffff";

            context.fillRect(
              0,
              0,
              viewport.width,
              viewport.height,
            );

            const task =
              result.page.render({
                canvasContext:
                  context,
                viewport,
              });

            renderTaskCacheRef.current.set(
              cacheKey,
              task,
            );

            try {
              await task.promise;
            } finally {
              if (
                renderTaskCacheRef.current.get(
                  cacheKey,
                ) === task
              ) {
                renderTaskCacheRef.current.delete(
                  cacheKey,
                );
              }
            }

            if (
              documentVersion !==
              documentVersionRef.current
            ) {
              return null;
            }

            const rendered = {
              canvas:
                renderCanvas,
              viewport,
              width:
                viewport.width,
              height:
                viewport.height,
            };

            renderedPageCacheRef.current.set(
              cacheKey,
              rendered,
            );

            return rendered;
          })();

        renderPromiseCacheRef.current.set(
          cacheKey,
          renderPromise,
        );

        try {
          return await renderPromise;
        } catch (err) {
          if (
            err?.name !==
            "RenderingCancelledException"
          ) {
            console.error(
              `Page ${pageNum} render error`,
              err,
            );
          }

          return null;
        } finally {
          if (
            renderPromiseCacheRef.current.get(
              cacheKey,
            ) === renderPromise
          ) {
            renderPromiseCacheRef.current.delete(
              cacheKey,
            );
          }
        }
      },
      [
        pdf,
        pageWidth,
        getPage,
      ],
    );

  /* ==========================================================
     PAINT PAGE
  ========================================================== */

  const paintPageToCanvas =
    useCallback(
      async (
        pageNum,
        canvas,
      ) => {
        if (!canvas) {
          return null;
        }

        const rendered =
          await getRenderedPage(
            pageNum,
          );

        if (!rendered) {
          return null;
        }

        const {
          canvas: sourceCanvas,
          viewport,
        } = rendered;

        const outputScale =
          window.devicePixelRatio ||
          1;

        canvas.width =
          Math.ceil(
            viewport.width *
              outputScale,
          );

        canvas.height =
          Math.ceil(
            viewport.height *
              outputScale,
          );

        canvas.style.width =
          `${viewport.width}px`;

        canvas.style.height =
          `${viewport.height}px`;

        const context =
          canvas.getContext(
            "2d",
            {
              alpha: false,
            },
          );

        if (!context) {
          return null;
        }

        context.setTransform(
          outputScale,
          0,
          0,
          outputScale,
          0,
          0,
        );

        context.fillStyle =
          "#ffffff";

        context.fillRect(
          0,
          0,
          viewport.width,
          viewport.height,
        );

        context.drawImage(
          sourceCanvas,
          0,
          0,
          sourceCanvas.width,
          sourceCanvas.height,
          0,
          0,
          viewport.width,
          viewport.height,
        );

        return rendered;
      },
      [getRenderedPage],
    );

  /* ==========================================================
     SINGLE PAGE
  ========================================================== */

  async function renderSinglePage(
    targetPage,
    showLoading,
  ) {
    if (!pdf) return;

    const canvas =
      singleCanvasRef.current;

    if (!canvas) return;

    const token =
      ++renderTokenRef.current;

    if (showLoading) {
      setLoading(true);
    }

    try {
      const rendered =
        await paintPageToCanvas(
          targetPage,
          canvas,
        );

      if (!rendered) return;

      if (
        token !==
        renderTokenRef.current
      ) {
        return;
      }

      const items =
        await getPageText(
          targetPage,
        );

      if (
        token !==
        renderTokenRef.current
      ) {
        return;
      }

      const basePage =
        await getPage(
          targetPage,
        );

      const data = {
        pageNumber:
          targetPage,
        items,
        viewport:
          rendered.viewport,
        baseWidth:
          basePage?.width ||
          rendered.viewport
            .width,
        baseHeight:
          basePage?.height ||
          rendered.viewport
            .height,
      };

      pageDataCacheRef.current.set(
        targetPage,
        data,
      );

      setSinglePageData(data);
    } catch (err) {
      if (
        err?.name !==
        "RenderingCancelledException"
      ) {
        console.error(err);
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }

  /* ==========================================================
     CONTINUOUS PAGE
  ========================================================== */

  const renderContinuousPage =
    useCallback(
      async (
        pageNum,
        canvas,
      ) => {
        if (
          !pdf ||
          !canvas
        ) {
          return null;
        }

        try {
          const rendered =
            await paintPageToCanvas(
              pageNum,
              canvas,
            );

          if (!rendered) {
            return null;
          }

          const items =
            await getPageText(
              pageNum,
            );

          const basePage =
            await getPage(
              pageNum,
            );

          const data = {
            pageNumber:
              pageNum,
            items,
            viewport:
              rendered.viewport,
            baseWidth:
              basePage?.width ||
              rendered.viewport
                .width,
            baseHeight:
              basePage?.height ||
              rendered.viewport
                .height,
          };

          pageDataCacheRef.current.set(
            pageNum,
            data,
          );

          return data;
        } catch (err) {
          if (
            err?.name !==
            "RenderingCancelledException"
          ) {
            console.error(
              `Page ${pageNum} render error`,
              err,
            );
          }

          return null;
        }
      },
      [
        pdf,
        paintPageToCanvas,
        getPageText,
        getPage,
      ],
    );

  /* ==========================================================
     NAVIGATION
  ========================================================== */

  function goToPage(
    nextPage,
  ) {
    if (!pdf) return;

    const target =
      clamp(
        nextPage,
        1,
        numPages,
      );

    setPageNumber(
      target,
    );

    lastScrollPageRef.current =
      target;

    if (
      viewMode ===
      "continuous"
    ) {
      const viewer =
        viewerRef.current;

      if (viewer) {
        const viewerTop =
          viewer.getBoundingClientRect()
            .top +
          window.scrollY;

        const targetTop =
          viewerTop +
          28 +
          (target - 1) *
            (
              pageHeight +
              PAGE_GAP
            );

        window.scrollTo({
          top: targetTop,
          behavior: "auto",
        });
      }
    }
  }

  /* ==========================================================
     COORDINATE CONVERSION
  ========================================================== */

  function getPdfPoint(
    event,
    pageData,
    container,
  ) {
    const rect =
      container.getBoundingClientRect();

    const baseWidth =
      pageData.baseWidth ||
      pageData.viewport.width;

    const baseHeight =
      pageData.baseHeight ||
      pageData.viewport.height;

    const screenX =
      event.clientX -
      rect.left;

    const screenY =
      event.clientY -
      rect.top;

    const scaleX =
      baseWidth /
      rect.width;

    const scaleY =
      baseHeight /
      rect.height;

    const x =
      screenX * scaleX;

    const topY =
      screenY * scaleY;

    const y =
      baseHeight - topY;

    return {
      x: clamp(
        x,
        0,
        baseWidth,
      ),
      y: clamp(
        y,
        0,
        baseHeight,
      ),
    };
  }

  /* ==========================================================
     RECTANGULAR SELECTION
  ========================================================== */

  function beginSelection(
    event,
    targetPage,
    pageData,
    container,
  ) {
    if (!selectionMode) return;

    if (!pageData?.viewport) {
      return;
    }

    event.preventDefault();

    const point =
      getPdfPoint(
        event,
        pageData,
        container,
      );

    try {
      container.setPointerCapture(
        event.pointerId,
      );
    } catch {}

    setDragging(true);

    dragStartRef.current = {
      x: point.x,
      y: point.y,
      pageNumber:
        targetPage,
    };

    setPageNumber(
      targetPage,
    );

    lastScrollPageRef.current =
      targetPage;

    setSelection({
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
      pageNumber:
        targetPage,
    });
  }

  function updateSelection(
    event,
    targetPage,
    pageData,
    container,
  ) {
    if (
      !selectionMode ||
      !dragging ||
      !dragStartRef.current
    ) {
      return;
    }

    const start =
      dragStartRef.current;

    if (
      start.pageNumber !==
      targetPage
    ) {
      return;
    }

    const point =
      getPdfPoint(
        event,
        pageData,
        container,
      );

    const left =
      Math.min(
        start.x,
        point.x,
      );

    const right =
      Math.max(
        start.x,
        point.x,
      );

    const bottom =
      Math.min(
        start.y,
        point.y,
      );

    const top =
      Math.max(
        start.y,
        point.y,
      );

    setSelection({
      x: left,
      y: bottom,
      width:
        right - left,
      height:
        top - bottom,
      pageNumber:
        targetPage,
    });
  }

  function finishSelection() {
    if (!dragging) return;

    setDragging(false);
    dragStartRef.current =
      null;
  }

  /* ==========================================================
     SELECTION ITEMS
  ========================================================== */

  function itemsInsideSelection() {
    if (!selection) {
      return [];
    }

    const pageData =
      pageDataCacheRef.current.get(
        selection.pageNumber,
      );

    const items =
      pageData?.items ||
      pageTextCacheRef.current.get(
        selection.pageNumber,
      );

    if (!items) {
      return [];
    }

    const right =
      selection.x +
      selection.width;

    const top =
      selection.y +
      selection.height;

    const bottom =
      selection.y;

    return items.filter(
      (item) => {
        const itemRight =
          item.x +
          item.width;

        const itemTop =
          item.y +
          item.height;

        const itemBottom =
          item.y;

        return (
          item.x <
            right &&
          itemRight >
            selection.x &&
          itemBottom <
            top &&
          itemTop >
            bottom
        );
      },
    );
  }

  /* ==========================================================
     SELECTION CONTROL
  ========================================================== */

  function activateSelectionMode() {
    setSelection(null);
    setDragging(false);
    dragStartRef.current =
      null;
    setSelectionMode(true);
  }

  function cancelSelectionMode() {
    clearSelection();
    setSelectionMode(false);
  }

  function clearSelection() {
    setSelection(null);
    dragStartRef.current =
      null;
    setDragging(false);
  }

  /* ==========================================================
     COPY UI
  ========================================================== */

  function showCopyMessage(
    message,
  ) {
    setCopyMessage(message);

    if (
      copyMessageTimerRef.current
    ) {
      clearTimeout(
        copyMessageTimerRef.current,
      );
    }

    copyMessageTimerRef.current =
      setTimeout(() => {
        setCopyMessage("");
      }, 1800);
  }

  function showCopyState(
    state,
  ) {
    setCopyState(state);

    if (
      copyStateTimerRef.current
    ) {
      clearTimeout(
        copyStateTimerRef.current,
      );
    }

    copyStateTimerRef.current =
      setTimeout(() => {
        setCopyState("idle");
      }, 1800);
  }

  async function copyText(
    text,
    message,
  ) {
    if (!text?.trim()) {
      showCopyMessage(
        "Nothing to copy",
      );

      return false;
    }

    try {
      await navigator.clipboard.writeText(
        text,
      );

      showCopyMessage(
        message,
      );

      return true;
    } catch (err) {
      console.error(err);

      showCopyMessage(
        "Copy failed",
      );

      return false;
    }
  }

  /* ==========================================================
     COPY SELECTION
  ========================================================== */

  async function copySelection() {
    if (!selectionMode) {
      activateSelectionMode();
      return;
    }

    if (!selection) return;

    const items =
      itemsInsideSelection();

    if (!items.length) {
      showCopyMessage(
        "No text found in selection",
      );

      return;
    }

    const text =
      convertItemsToExcel(
        items,
      );

    const rows =
      buildCells(items);

    const copied =
      await copyText(
        text,
        `Copied ${rows.length} row${
          rows.length ===
          1
            ? ""
            : "s"
        }`,
      );

    if (copied) {
      setSelectionMode(false);
      clearSelection();
    }
  }

  /* ==========================================================
     COPY PAGE
  ========================================================== */

  async function copyPage() {
    const targetPage =
      pageNumber;

    const items =
      await getPageText(
        targetPage,
      );

    const text =
      convertItemsToExcel(
        items,
      );

    if (!text.trim()) {
      showCopyMessage(
        `Page ${targetPage} has no text`,
      );

      return;
    }

    const copied =
      await copyText(
        text,
        `Page ${targetPage} copied`,
      );

    if (copied) {
      showCopyState(
        "copied",
      );
    }
  }

  const structuredSelectionItems =
    itemsInsideSelection();

  const hasStructuredSelection =
    structuredSelectionItems.length >
    0;

  /* ==========================================================
     RENDER
  ========================================================== */

  return (
    <div
      className="min-h-screen bg-[#080b11] text-slate-200"
      tabIndex={0}
      onKeyDown={(event) => {
        if (!pdf) return;

        if (
          event.key ===
          "ArrowRight"
        ) {
          event.preventDefault();

          goToPage(
            pageNumber + 1,
          );
        }

        if (
          event.key ===
          "ArrowLeft"
        ) {
          event.preventDefault();

          goToPage(
            pageNumber - 1,
          );
        }

        if (
          event.key ===
          "Escape"
        ) {
          if (selectionMode) {
            cancelSelectionMode();
          }
        }
      }}
    >
      <header className="sticky top-0 z-[200] h-[48px] border-b border-white/[0.06] bg-[#0a0e15]/95 backdrop-blur-xl">
        <div className="mx-auto flex h-full max-w-[1500px] items-center px-5 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center">
              <div className="relative h-6 w-6">
                <div className="absolute left-0 top-3 h-[2px] w-6 bg-slate-500" />

                <div className="absolute left-[11px] top-1 h-5 w-[2px] bg-[#6f89b8]" />

                <div className="absolute left-[3px] top-0 h-3 w-[18px] rounded-t-full border-2 border-slate-500 border-b-0" />
              </div>
            </div>

            <div>
              <div className="text-[14px] font-semibold tracking-[0.22em]">
                E-BRIDGE
              </div>

              <div className="hidden text-[8px] uppercase tracking-[0.22em] text-slate-600 sm:block">
                Financial document workspace
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1500px] flex-col px-3 py-2 sm:px-5 lg:px-8">
        <div className="mb-1 flex items-center justify-between gap-3">
          <div className="min-w-0">
            {pdf ? (
              <>
                <div className="max-w-[500px] truncate text-[12px] font-medium text-slate-300">
                  {fileName}
                </div>

                <div className="mt-0.5 text-[9px] text-slate-600">
                  {numPages} pages
                </div>
              </>
            ) : (
              <div className="text-[11px] text-slate-600">
                Open a financial PDF to begin.
              </div>
            )}
          </div>

          <button
            onClick={() =>
              fileInputRef.current?.click()
            }
            className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-[9px] font-medium uppercase tracking-[0.12em] text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
          >
            Open PDF
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={
              handleFileChange
            }
          />
        </div>

        {pdf && (
          <div
            className={`sticky top-[54px] z-[150] mb-1 transition-all ${
              toolbarPinned
                ? "rounded-xl border border-white/[0.09] bg-[#0b1017]/96 shadow-xl backdrop-blur-xl"
                : "pointer-events-none"
            }`}
          >
            <div
              className={`flex flex-wrap items-center justify-between gap-2 py-1.5 ${
                toolbarPinned
                  ? "px-2"
                  : ""
              }`}
            >
              <div
                className={`pointer-events-auto flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-[#0b1017]/70 px-1.5 py-1 shadow-lg backdrop-blur-xl ${
                  toolbarPinned
                    ? "bg-transparent shadow-none"
                    : ""
                }`}
              >
                <button
                  onClick={() =>
                    goToPage(
                      pageNumber - 1,
                    )
                  }
                  disabled={
                    pageNumber <= 1
                  }
                  className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-20"
                >
                  ←
                </button>

                <div className="min-w-[58px] text-center text-[10px] tabular-nums text-slate-500">
                  <span className="text-slate-200">
                    {pageNumber}
                  </span>{" "}
                  / {numPages}
                </div>

                <button
                  onClick={() =>
                    goToPage(
                      pageNumber + 1,
                    )
                  }
                  disabled={
                    pageNumber >=
                    numPages
                  }
                  className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-20"
                >
                  →
                </button>

                <div className="mx-1 h-5 w-px bg-white/[0.07]" />

                <button
                  onClick={() =>
                    setViewMode(
                      "continuous",
                    )
                  }
                  className={`rounded-md px-2.5 py-1.5 text-[9px] uppercase tracking-[0.1em] transition ${
                    viewMode ===
                    "continuous"
                      ? "bg-white/[0.09] text-white"
                      : "text-slate-600 hover:text-slate-300"
                  }`}
                >
                  Continuous
                </button>

                <button
                  onClick={() =>
                    setViewMode(
                      "single",
                    )
                  }
                  className={`rounded-md px-2.5 py-1.5 text-[9px] uppercase tracking-[0.1em] transition ${
                    viewMode ===
                    "single"
                      ? "bg-white/[0.09] text-white"
                      : "text-slate-600 hover:text-slate-300"
                  }`}
                >
                  Single
                </button>

                <div className="mx-1 h-5 w-px bg-white/[0.07]" />

                <button
                  onClick={() =>
                    changeZoom(
                      -ZOOM_STEP,
                    )
                  }
                  disabled={
                    zoom <= MIN_ZOOM
                  }
                  className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-20"
                >
                  −
                </button>

                <button
                  onClick={
                    resetZoom
                  }
                  className="min-w-[42px] rounded-md px-1 py-1.5 text-[9px] tabular-nums text-slate-500 transition hover:bg-white/[0.06] hover:text-white"
                >
                  {Math.round(
                    zoom * 100,
                  )}
                  %
                </button>

                <button
                  onClick={() =>
                    changeZoom(
                      ZOOM_STEP,
                    )
                  }
                  disabled={
                    zoom >= MAX_ZOOM
                  }
                  className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-20"
                >
                  +
                </button>
              </div>

              <div
                className={`pointer-events-auto flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-[#0b1017]/70 px-1.5 py-1 shadow-lg backdrop-blur-xl ${
                  toolbarPinned
                    ? "bg-transparent shadow-none"
                    : ""
                }`}
              >
                <button
                  onClick={
                    copySelection
                  }
                  className={`rounded-md border px-3 py-1.5 text-[9px] font-medium uppercase tracking-[0.1em] transition ${
                    hasStructuredSelection
                      ? "border-blue-400 bg-blue-600 text-white shadow-[0_0_14px_rgba(37,99,235,0.35)] hover:bg-blue-500"
                      : selectionMode
                        ? "border-[#536d9f]/40 bg-[#536d9f]/15 text-[#b9c9e5]"
                        : "border-white/[0.07] bg-white/[0.025] text-slate-400 hover:border-[#536d9f]/30 hover:bg-[#536d9f]/10 hover:text-[#b9c9e5]"
                  }`}
                  title={
                    hasStructuredSelection
                      ? "Copy the selected area"
                      : selectionMode
                        ? "Drag across the document to select an area"
                        : "Activate rectangular selection"
                  }
                >
                  {hasStructuredSelection
                    ? "Copy Selection"
                    : selectionMode
                      ? "Select Mode On"
                      : "Select to Copy"}
                </button>

                <button
                  onClick={
                    copyPage
                  }
                  className={`rounded-md border px-3 py-1.5 text-[9px] font-medium uppercase tracking-[0.1em] transition ${
                    copyState ===
                    "copied"
                      ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                      : "border-white/[0.07] bg-white/[0.025] text-slate-400 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  {copyState ===
                  "copied"
                    ? "✓ Copied"
                    : "Copy Page"}
                </button>

                <div className="mx-0.5 h-5 w-px bg-white/[0.07]" />

                <button
                  onClick={() =>
                    setToolbarPinned(
                      (current) =>
                        !current,
                    )
                  }
                  className={`flex h-7 w-7 items-center justify-center rounded-md border transition ${
                    toolbarPinned
                      ? "border-[#6f89b8]/30 bg-[#536d9f]/15 text-[#b9c9e5]"
                      : "border-transparent text-slate-600 hover:bg-white/[0.06] hover:text-slate-300"
                  }`}
                  title={
                    toolbarPinned
                      ? "Unpin toolbar"
                      : "Pin toolbar"
                  }
                >
                  <span
                    className={`text-[12px] ${
                      toolbarPinned
                        ? "rotate-0"
                        : "rotate-45"
                    }`}
                  >
                    ●
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-2 rounded-lg border border-red-500/10 bg-red-500/[0.04] px-3 py-2 text-[10px] text-red-300">
            {error}
          </div>
        )}

        <div
          ref={viewerRef}
          className={`relative overflow-x-auto rounded-xl border border-white/[0.07] bg-[#10151d] shadow-[0_25px_80px_rgba(0,0,0,0.25)] ${
            pdf
              ? ""
              : "h-[calc(100vh-58px)] min-h-[650px]"
          }`}
        >
          {!pdf ? (
            <EmptyState
              onOpen={() =>
                fileInputRef.current?.click()
              }
            />
          ) : viewMode ===
            "continuous" ? (
            <ContinuousDocument
              numPages={
                numPages
              }
              pageNumber={
                pageNumber
              }
              pageWidth={
                pageWidth
              }
              pageHeight={
                pageHeight
              }
              documentHeight={
                documentHeight
              }
              pageDataCacheRef={
                pageDataCacheRef
              }
              selection={
                selection
              }
              dragging={
                dragging
              }
              selectionMode={
                selectionMode
              }
              onBeginSelection={
                beginSelection
              }
              onUpdateSelection={
                updateSelection
              }
              onFinishSelection={
                finishSelection
              }
              renderPage={
                renderContinuousPage
              }
              buffer={
                PAGE_BUFFER
              }
            />
          ) : (
            <SingleDocument
              pageWidth={
                pageWidth
              }
              pageHeight={
                pageHeight
              }
              pageData={
                singlePageData
              }
              canvasRef={
                singleCanvasRef
              }
              selection={
                selection
              }
              dragging={
                dragging
              }
              selectionMode={
                selectionMode
              }
              loading={
                loading
              }
              onBeginSelection={
                beginSelection
              }
              onUpdateSelection={
                updateSelection
              }
              onFinishSelection={
                finishSelection
              }
              pageNumber={
                pageNumber
              }
            />
          )}

          {copyMessage && (
            <div className="pointer-events-none absolute bottom-5 left-1/2 z-[100] -translate-x-1/2">
              <div className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-[#101820]/95 px-4 py-2.5 shadow-2xl backdrop-blur-xl">
                <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-slate-300">
                  ✓ {copyMessage}
                </span>
              </div>
            </div>
          )}

          {selectionMode &&
            !selection && (
              <div className="pointer-events-none absolute bottom-5 left-1/2 z-[90] -translate-x-1/2">
                <div className="rounded-lg border border-white/[0.08] bg-[#0b1017]/80 px-3 py-2 text-[9px] uppercase tracking-[0.1em] text-slate-500 shadow-xl backdrop-blur-md">
                  Drag across the area to copy
                </div>
              </div>
            )}
        </div>

        {pdf && (
          <div className="flex items-center justify-between px-1 pt-2">
            <div className="text-[8px] uppercase tracking-[0.14em] text-slate-700">
              E-BRIDGE · Financial document workspace
            </div>

            <div className="text-[8px] uppercase tracking-[0.14em] text-slate-700">
              Made by Ernest
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   CONTINUOUS DOCUMENT
============================================================ */

function ContinuousDocument({
  numPages,
  pageNumber,
  pageWidth,
  pageHeight,
  documentHeight,
  pageDataCacheRef,
  selection,
  dragging,
  selectionMode,
  onBeginSelection,
  onUpdateSelection,
  onFinishSelection,
  renderPage,
  buffer,
}) {
  const startPage =
    Math.max(
      1,
      pageNumber - buffer,
    );

  const endPage =
    Math.min(
      numPages,
      pageNumber + buffer,
    );

  return (
    <div
      className="relative w-full"
      style={{
        minHeight:
          documentHeight + 56,
      }}
    >
      <div className="flex w-full flex-col items-center px-5 py-7">
        {Array.from(
          {
            length: numPages,
          },
          (_, index) => {
            const targetPage =
              index + 1;

            const active =
              targetPage >=
                startPage &&
              targetPage <=
                endPage;

            return (
              <div
                key={targetPage}
                className="relative flex w-full justify-center"
                style={{
                  height:
                    pageHeight,
                  marginBottom:
                    targetPage ===
                    numPages
                      ? 0
                      : PAGE_GAP,
                }}
              >
                {active ? (
                  <VirtualPage
                    pageNum={
                      targetPage
                    }
                    pageWidth={
                      pageWidth
                    }
                    pageHeight={
                      pageHeight
                    }
                    pageDataCacheRef={
                      pageDataCacheRef
                    }
                    selection={
                      selection
                    }
                    dragging={
                      dragging
                    }
                    selectionMode={
                      selectionMode
                    }
                    onBeginSelection={
                      onBeginSelection
                    }
                    onUpdateSelection={
                      onUpdateSelection
                    }
                    onFinishSelection={
                      onFinishSelection
                    }
                    renderPage={
                      renderPage
                    }
                  />
                ) : (
                  <div
                    className="h-full bg-white/[0.012]"
                    style={{
                      width:
                        pageWidth,
                    }}
                  />
                )}
              </div>
            );
          },
        )}
      </div>
    </div>
  );
}

/* ============================================================
   VIRTUAL PAGE
============================================================ */

const VirtualPage = memo(
  function VirtualPage({
    pageNum,
    pageWidth,
    pageHeight,
    pageDataCacheRef,
    selection,
    dragging,
    selectionMode,
    onBeginSelection,
    onUpdateSelection,
    onFinishSelection,
    renderPage,
  }) {
    const canvasRef =
      useRef(null);

    const [pageData, setPageData] =
      useState(
        pageDataCacheRef.current.get(
          pageNum,
        ) || null,
      );

    const [ready, setReady] =
      useState(false);

    useEffect(() => {
      let cancelled = false;

      async function prepare() {
        if (
          !canvasRef.current
        ) {
          return;
        }

        const existing =
          pageDataCacheRef.current.get(
            pageNum,
          );

        if (existing) {
          setPageData(
            existing,
          );

          setReady(true);
        }

        const result =
          await renderPage(
            pageNum,
            canvasRef.current,
          );

        if (cancelled) {
          return;
        }

        if (result) {
          setPageData(result);
          setReady(true);
        }
      }

      prepare();

      return () => {
        cancelled = true;
      };
    }, [
      pageNum,
      renderPage,
    ]);

    const actualViewport =
      pageData?.viewport || {
        width: pageWidth,
        height: pageHeight,
      };

    const baseWidth =
      pageData?.baseWidth ||
      actualViewport.width;

    const baseHeight =
      pageData?.baseHeight ||
      actualViewport.height;

    const isSelectedPage =
      selection?.pageNumber ===
      pageNum;

    let selectionStyle =
      null;

    if (
      isSelectedPage &&
      selection
    ) {
      const left =
        (selection.x /
          baseWidth) *
        100;

      const top =
        (1 -
          (selection.y +
            selection.height) /
            baseHeight) *
        100;

      const width =
        (selection.width /
          baseWidth) *
        100;

      const height =
        (selection.height /
          baseHeight) *
        100;

      selectionStyle = {
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
      };
    }

    return (
      <div
        className={`relative flex-none overflow-hidden bg-white shadow-[0_25px_70px_rgba(0,0,0,0.35)] ${
          selectionMode
            ? "cursor-crosshair select-none"
            : "cursor-text"
        }`}
        style={{
          width:
            actualViewport.width,
          height:
            actualViewport.height,
        }}
        onPointerDown={(
          event,
        ) =>
          onBeginSelection(
            event,
            pageNum,
            pageData,
            event.currentTarget,
          )
        }
        onPointerMove={(
          event,
        ) =>
          onUpdateSelection(
            event,
            pageNum,
            pageData,
            event.currentTarget,
          )
        }
        onPointerUp={
          onFinishSelection
        }
        onPointerCancel={
          onFinishSelection
        }
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block h-full w-full"
        />

        {!ready && (
          <div className="absolute inset-0 bg-white" />
        )}

        {pageData?.items?.length >
          0 && (
          <div
            className={`absolute inset-0 ${
              selectionMode
                ? "pointer-events-none"
                : "pointer-events-auto"
            }`}
          >
            {pageData.items.map(
              (
                item,
                index,
              ) => {
                const left =
                  (item.x /
                    baseWidth) *
                  100;

                const top =
                  (1 -
                    (item.y +
                      item.height) /
                      baseHeight) *
                  100;

                const width =
                  (item.width /
                    baseWidth) *
                  100;

                const height =
                  (item.height /
                    baseHeight) *
                  100;

                return (
                  <span
                    key={`${pageNum}-${index}-${item.x}-${item.y}`}
                    className="absolute whitespace-pre text-transparent selection:bg-[#6f89b8]/30"
                    style={{
                      left: `${left}%`,
                      top: `${top}%`,
                      width: `${width}%`,
                      height: `${height}%`,
                      fontSize: `${Math.max(
                        7,
                        (item.height /
                          baseHeight) *
                          actualViewport.height,
                      )}px`,
                      lineHeight: 1,
                    }}
                  >
                    {item.text}
                  </span>
                );
              },
            )}
          </div>
        )}

        {selectionStyle &&
          selectionMode && (
            <div
              className={`pointer-events-none absolute z-30 border ${
                dragging
                  ? "border-[#7890bd] bg-[#7890bd]/15"
                  : "border-[#6f89b8] bg-[#6f89b8]/10"
              }`}
              style={
                selectionStyle
              }
            />
          )}
      </div>
    );
  },
);

/* ============================================================
   SINGLE DOCUMENT
============================================================ */

function SingleDocument({
  pageWidth,
  pageHeight,
  pageData,
  canvasRef,
  selection,
  dragging,
  selectionMode,
  loading,
  onBeginSelection,
  onUpdateSelection,
  onFinishSelection,
  pageNumber,
}) {
  const viewport =
    pageData?.viewport || {
      width: pageWidth,
      height: pageHeight,
    };

  const baseWidth =
    pageData?.baseWidth ||
    viewport.width;

  const baseHeight =
    pageData?.baseHeight ||
    viewport.height;

  let selectionStyle =
    null;

  if (
    selection &&
    selection.pageNumber ===
      pageNumber &&
    pageData
  ) {
    selectionStyle = {
      left:
        (selection.x /
          baseWidth) *
          100 +
        "%",

      top:
        (1 -
          (selection.y +
            selection.height) /
            baseHeight) *
          100 +
        "%",

      width:
        (selection.width /
          baseWidth) *
          100 +
        "%",

      height:
        (selection.height /
          baseHeight) *
          100 +
        "%",
    };
  }

  return (
    <div className="flex min-h-full w-max min-w-full items-start justify-center px-5 py-7">
      <div
        className={`relative flex-none overflow-hidden bg-white shadow-[0_25px_70px_rgba(0,0,0,0.35)] ${
          selectionMode
            ? "cursor-crosshair select-none"
            : "cursor-text"
        }`}
        style={{
          width:
            viewport.width,
          height:
            viewport.height,
        }}
        onPointerDown={(
          event,
        ) =>
          onBeginSelection(
            event,
            pageNumber,
            pageData,
            event.currentTarget,
          )
        }
        onPointerMove={(
          event,
        ) =>
          onUpdateSelection(
            event,
            pageNumber,
            pageData,
            event.currentTarget,
          )
        }
        onPointerUp={
          onFinishSelection
        }
        onPointerCancel={
          onFinishSelection
        }
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block h-full w-full"
        />

        {pageData?.items?.length >
          0 && (
          <div
            className={`absolute inset-0 ${
              selectionMode
                ? "pointer-events-none"
                : "pointer-events-auto"
            }`}
          >
            {pageData.items.map(
              (
                item,
                index,
              ) => {
                const left =
                  (item.x /
                    baseWidth) *
                  100;

                const top =
                  (1 -
                    (item.y +
                      item.height) /
                      baseHeight) *
                  100;

                const width =
                  (item.width /
                    baseWidth) *
                  100;

                const height =
                  (item.height /
                    baseHeight) *
                  100;

                return (
                  <span
                    key={`${index}-${item.x}-${item.y}`}
                    className="absolute whitespace-pre text-transparent selection:bg-[#6f89b8]/30"
                    style={{
                      left: `${left}%`,
                      top: `${top}%`,
                      width: `${width}%`,
                      height: `${height}%`,
                      fontSize: `${Math.max(
                        7,
                        (item.height /
                          baseHeight) *
                          viewport.height,
                      )}px`,
                      lineHeight: 1,
                    }}
                  >
                    {item.text}
                  </span>
                );
              },
            )}
          </div>
        )}

        {selectionStyle &&
          selectionMode && (
            <div
              className={`pointer-events-none absolute z-30 border ${
                dragging
                  ? "border-[#7890bd] bg-[#7890bd]/15"
                  : "border-[#6f89b8] bg-[#6f89b8]/10"
              }`}
              style={
                selectionStyle
              }
            />
          )}

        {loading && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-white/60">
            <div className="rounded-lg border border-black/[0.08] bg-white/90 px-3 py-2 shadow-lg">
              <span className="text-[10px] uppercase tracking-[0.12em] text-slate-500">
                Loading page
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   EMPTY STATE
============================================================ */

function EmptyState({
  onOpen,
}) {
  return (
    <div className="relative h-full overflow-hidden bg-[#0c1118]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full bg-[#172235]/20 blur-[140px]" />

        <div className="absolute -bottom-60 right-[-100px] h-[440px] w-[440px] rounded-full bg-[#101a2a]/20 blur-[140px]" />

        <div className="absolute inset-0 opacity-[0.018] [background-image:linear-gradient(rgba(255,255,255,.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.8)_1px,transparent_1px)] [background-size:48px_48px]" />
      </div>

      <div className="relative mx-auto max-w-5xl px-6 py-7 md:px-10 md:py-8 lg:px-14">
        <div className="grid gap-7 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.24em] text-slate-600">
              Structured data extraction
            </div>

            <h1 className="mt-3 max-w-2xl text-3xl font-medium leading-[1.05] tracking-[-0.04em] text-slate-200 md:text-[40px]">
              From PDF table
              <br />
              to Excel in seconds.
            </h1>

            <p className="mt-4 max-w-xl text-[13px] leading-5.5 text-slate-500">
              Read documents normally, decide what
              matters, and select only the information
              you need. E-BRIDGE handles the mechanical
              work of extracting it into Excel, while you
              stay in control of the analysis.
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-4">
              <button
                onClick={
                  onOpen
                }
                className="group flex items-center gap-3 rounded-lg bg-slate-200 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#080b10] transition hover:bg-white"
              >
                Open PDF

                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                >
                  <path
                    d="M3 8h10M9 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              <span className="text-[9px] uppercase tracking-[0.15em] text-slate-700">
                Files stay in your browser
              </span>
            </div>
          </div>

          <div className="hidden lg:block">
            <div className="relative mx-auto max-w-[280px]">
              <div className="rounded-xl border border-white/[0.07] bg-[#0b1017] p-2.5 shadow-2xl">
                <div className="rounded-lg border border-white/[0.05] bg-[#0d131b] p-4">
                  <div className="flex items-center justify-between">
                    <div className="h-2 w-20 rounded-full bg-white/[0.08]" />
                    <div className="h-2 w-8 rounded-full bg-white/[0.04]" />
                  </div>

                  <div className="mt-4 space-y-2">
                    <div className="h-2 w-full rounded bg-white/[0.045]" />
                    <div className="h-2 w-[88%] rounded bg-white/[0.045]" />
                    <div className="h-2 w-[94%] rounded bg-white/[0.045]" />
                    <div className="h-2 w-[72%] rounded bg-white/[0.045]" />
                  </div>

                  <div className="relative mt-5 overflow-hidden rounded border border-slate-500/20">
                    <div className="grid grid-cols-4 border-b border-white/[0.06] bg-white/[0.025]">
                      <div className="h-6 border-r border-white/[0.05]" />
                      <div className="h-6 border-r border-white/[0.05]" />
                      <div className="h-6 border-r border-white/[0.05]" />
                      <div className="h-6" />
                    </div>

                    {[1, 2, 3, 4].map(
                      (row) => (
                        <div
                          key={row}
                          className="grid grid-cols-4 border-b border-white/[0.045] last:border-0"
                        >
                          <div className="h-7 border-r border-white/[0.045]" />
                          <div className="h-7 border-r border-white/[0.045]" />
                          <div className="h-7 border-r border-white/[0.045]" />
                          <div className="h-7" />
                        </div>
                      ),
                    )}

                    <div className="pointer-events-none absolute left-7 right-7 top-[38px] h-[82px] rounded border border-slate-400/30 bg-slate-400/[0.035]" />
                  </div>
                </div>
              </div>

              <div className="absolute -bottom-3 -right-3 rounded-lg border border-white/[0.08] bg-[#0c121a] px-3 py-2 shadow-xl">
                <div className="text-[8px] uppercase tracking-[0.18em] text-slate-600">
                  Selected
                </div>

                <div className="mt-1 text-[10px] text-slate-400">
                  Table → Clipboard
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 grid border-y border-white/[0.06] md:grid-cols-3">
          <div className="border-b border-white/[0.06] py-4 md:border-b-0 md:border-r md:pr-6">
            <div className="text-[9px] tracking-[0.18em] text-slate-600">
              01
            </div>

            <h2 className="mt-2 text-sm font-medium text-slate-300">
              Read
            </h2>

            <p className="mt-1.5 max-w-xs text-[10px] leading-4.5 text-slate-600">
              Read the document normally and use your own
              judgement to identify what matters.
            </p>
          </div>

          <div className="border-b border-white/[0.06] py-4 md:border-b-0 md:border-r md:px-6">
            <div className="text-[9px] tracking-[0.18em] text-slate-600">
              02
            </div>

            <h2 className="mt-2 text-sm font-medium text-slate-300">
              Select
            </h2>

            <p className="mt-1.5 max-w-xs text-[10px] leading-4.5 text-slate-600">
              Choose the exact table, section, or page you need.
              E-BRIDGE handles the mechanical extraction.
            </p>
          </div>

          <div className="py-4 md:pl-6">
            <div className="text-[9px] tracking-[0.18em] text-slate-600">
              03
            </div>

            <h2 className="mt-2 text-sm font-medium text-slate-300">
              Use
            </h2>

            <p className="mt-1.5 max-w-xs text-[10px] leading-4.5 text-slate-600">
              Copy the structured result directly into Excel and
              continue your analysis.
            </p>
          </div>
        </div>

        <div className="mt-6 border-b border-white/[0.06] pb-6">
          <div className="text-[8px] font-medium uppercase tracking-[0.18em] text-slate-600">
            Current scope
          </div>

          <p className="mt-2 max-w-3xl text-[10px] leading-5 text-slate-700">
            Currently tested on text-based annual reports.
            Image-based PDFs are not supported. Tables with
            irregular layouts or missing cells may require a
            quick visual check after pasting.
          </p>

          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[8px] uppercase tracking-[0.15em] text-slate-700">
            <span>
              Text PDFs
            </span>

            <span>
              Annual Reports
            </span>

            <span>
              Excel Clipboard
            </span>

            <span>
              Local Processing
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between pt-4">
          <div className="text-[8px] uppercase tracking-[0.18em] text-slate-700">
            Built by Ernest Ngugi
          </div>

          <div className="text-[8px] uppercase tracking-[0.15em] text-slate-800">
            E-BRIDGE
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;