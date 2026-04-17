# Profile Module

## URL
http://localhost:4000/profile

## Description
Allows users to view and update their account information.

## Elements
- Profile heading: #profile-heading
- Profile name display: #profile-name (text: Admin User)
- Email input: #profile-email (default: admin@testapp.com)
- Username input: #profile-username (default: admin)
- Save button: #save-profile-btn
- Save confirmation: #save-msg (appears briefly after saving)

## Prerequisites
- Must be logged in with admin/admin
- Navigate via nav link or directly to /profile

## Behaviour
- Save button shows #save-msg for 2 seconds
- Changes are not persisted (demo app — page refresh resets values)

## Test Scenarios
- view_profile: Navigate to profile — verify profile heading and name are visible
- save_profile: Navigate to profile, update email field, click save — verify #save-msg appears