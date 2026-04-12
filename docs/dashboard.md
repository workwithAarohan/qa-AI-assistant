# Dashboard

## How to reach it
- Navigate to http://localhost:4000/testapp and log in with admin/admin
- The page DOM is replaced with <h2>Dashboard</h2> — no URL change

## Elements
- Dashboard heading: h2 containing "Dashboard"

## Notes
- Since login replaces the DOM rather than navigating, use expect with a selector
  rather than expectUrl for post-login verification