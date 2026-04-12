# Login Feature

Page URL: http://localhost:4000/testapp
Test app file: index.html (served statically)

## Elements
- Username input: #username
- Password input: #password
- Login button: #login-btn
- Error message: #error (visible on failed login)

## Business rules
- Valid credentials: username=admin, password=admin
- Any other combination shows #error in red
- Successful login replaces the page with a dashboard view showing <h2>Dashboard</h2>
- There is no redirect — the DOM is replaced in place

## Test scenarios
- Valid login: should reach dashboard
- Invalid password: should show #error
- Empty fields: should show #error