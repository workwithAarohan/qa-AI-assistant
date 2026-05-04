# Login Module

## URL
http://localhost:4000/testapp

## Description
The login page is the entry point of the application.
Users authenticate with a username and password.

## Elements
- Username input: #username
- Password input: #password
- Login button: #login-btn
- Error message: #error (visible on failed login)

## Credentials
- Valid: username=admin, password=admin
- Invalid: any other combination

## Behaviour
- Valid login → navigates to /dashboard
- Invalid login → #error becomes visible, page stays on login
- Empty fields → #error becomes visible

## Test Scenarios
- valid_login: Login with admin/admin — should reach dashboard
- invalid_password: Login with admin/wrongpassword — should show #error
- empty_fields: Submit login form without filling any fields and verify the error message appears.
