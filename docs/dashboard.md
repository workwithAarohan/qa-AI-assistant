# Dashboard

URL: /testapp/dashboard.html
Elements: #page-title, #stat-projects, #new-project-btn, #view-projects-btn
Nav links: Dashboard, Projects, Profile, Logout (#logout-link)

## Notes
- Since login replaces the DOM rather than navigating, use expect with a selector
  rather than expectUrl for post-login verification