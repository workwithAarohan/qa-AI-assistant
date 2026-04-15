# Dashboard Module

## URL
http://localhost:4000/testapp/dashboard.html

## Description
The dashboard is the main screen after login.
It shows project stats and quick action buttons.

## Elements
- Page heading: #page-title (text: "Dashboard")
- Welcome message: #welcome-msg
- Project count stat: #stat-projects
- New project button: #new-project-btn
- View projects button: #view-projects-btn
- Nav links: #nav-dashboard, #nav-projects, #nav-profile
- Logout: #logout-link

## Behaviour
- Accessible only after login
- Clicking #new-project-btn navigates to /testapp/projects.html?new=1
- Clicking #view-projects-btn navigates to /testapp/projects.html

## Test Scenarios
- dashboard_loads: After login verify dashboard heading and welcome message visible
- navigate_to_projects: Click view projects button — should reach projects page
- new_project_shortcut: Click new project button — should open projects page with modal open