# Navigation Module

## URL
http://localhost:4000/testapp

## Description
End-to-end user flows that span multiple pages.

## Nav Elements (shared across all pages after login)
- Dashboard link: #nav-dashboard → /dashboard
- Projects link: #nav-projects → /projects
- Profile link: #nav-profile → /profile
- Logout link: #logout-link → /testapp (login page)

## Behaviour
- Navigation bar is present on all pages after login
- Logout returns user to login page and requires re-authentication

## Test Scenarios
- full_login_flow: Login with admin/admin, verify dashboard loads, navigate to projects, verify projects page loads
- logout_flow: Login with admin/admin, reach dashboard, click logout — should return to login page