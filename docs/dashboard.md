# Dashboard Module

## URL
http://localhost:4000/dashboard

## Description
The main screen after login showing stats and navigation.

## Elements
- Page heading: #page-title (text: Dashboard)
- Welcome message: #welcome-msg
- Project count stat: #stat-projects
- New project button: #new-project-btn
- View projects button: #view-projects-btn
- Nav links: #nav-dashboard, #nav-projects, #nav-profile
- Logout link: #logout-link

## Prerequisites
- Must be logged in with admin/admin first
- Login page is at http://localhost:4000/testapp

## Behaviour
- Accessible only after login
- #new-project-btn navigates to /projects?new=1 (opens modal)
- #view-projects-btn navigates to /projects
- #logout-link navigates back to /testapp (login page)

## Test Scenarios
- dashboard_loads: Login then verify dashboard heading and welcome message are visible
- navigate_to_projects: Login then click view projects button — should reach projects page
- new_project_shortcut: Login then click new project button — should open projects page with modal