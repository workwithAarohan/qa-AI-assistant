# Validation Module

## URL
http://localhost:5000/validation

## Description
Form with complex validation rules — required fields, format checks (email, phone), min/max lengths, and cross-field dependencies. Validation runs on blur and on submit.

## Elements
- Form: #validation-form
- Full name: #field-name (required, min 3 chars)
- Email: #field-email (required, must match email format)
- Phone: #field-phone (optional, must match XXX-XXX-XXXX if provided)
- Department select: #field-dept (required, options: Engineering, QA, Product, Design)
- Start date: #field-start (required, must not be in the past)
- Submit button: #form-submit
- Success message: #form-success (appears on valid submit)
- Error summary: #error-summary (lists all field errors on invalid submit)
- Per-field errors: .field-error (appears next to each invalid field)

## Prerequisites
- No login required
- Navigate directly to /validation

## Behaviour
- Each field validates on blur (leaving the field)
- Submit button validates all fields together
- #error-summary lists all errors at top of form on submit failure
- On success, #form-success appears and form resets
- Phone field only validates format IF a value is entered (optional field)
- Department select defaults to empty — user must choose

## Test Scenarios
- valid_submit: Fill all required fields correctly, submit — verify #form-success appears
- empty_submit: Click submit without filling any fields — verify #error-summary appears with all required field errors
- invalid_email: Enter an invalid email format, blur the field — verify .field-error appears on the email field
- invalid_phone_format: Enter a phone number without dashes (e.g. 1234567890), submit — verify phone .field-error appears
- past_date: Enter a start date in the past, submit — verify start date .field-error appears