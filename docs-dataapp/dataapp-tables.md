# Tables Module

## URL
http://localhost:4001/tables

## Description
Backend-driven data table with column filtering, pagination, and row-level validation. Data is fetched from an API and rendered dynamically — selectors are discovered via live DOM inspection.

## Elements
Note: this module is DOM-driven. The agent discovers selectors via live browser inspection before generating steps.

- Table container: #data-table (contains all rows)
- Filter input: #filter-input (filters visible rows by text match)
- Column sort buttons: [data-sort] (click to sort by column)
- Pagination controls: #page-prev, #page-next, #page-info
- Row count display: #row-count
- Export button: #export-btn
- Error banner: #table-error (appears on API failure)
- Loading spinner: #table-loading (visible during fetch)

## Prerequisites
- No login required
- Data loads automatically on page load

## Behaviour
- Filter input filters rows client-side as user types (debounced 300ms)
- Sorting is ascending on first click, descending on second
- #row-count updates after each filter/sort operation
- Pagination: 10 rows per page, #page-info shows "Page N of M"
- Export downloads a CSV of the currently visible (filtered) rows
- If API fails, #table-error appears with the error message

## Test Scenarios
- table_loads: Navigate to /tables — verify #data-table is visible and #row-count is not zero
- filter_by_text: Navigate to /tables, type a search term into #filter-input — verify #row-count decreases
- sort_column: Navigate to /tables, click a [data-sort] column header — verify table re-renders
- pagination: Navigate to /tables, click #page-next — verify #page-info changes to Page 2
- export_csv: Navigate to /tables, click #export-btn — verify file download initiates