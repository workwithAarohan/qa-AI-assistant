# Projects Module

## URL
http://localhost:4000/projects

## Description
Lists all projects and allows creating new ones via a modal form.

## Elements
- Page heading: #projects-heading
- New project button: #new-project-btn
- Project list: #project-list
- Success message: #success-msg (appears after project creation)

## Modal Elements (opens after clicking #new-project-btn)
- Project name input: #project-name-input
- Project type select: #project-type-select (options: web, mobile, api)
- Create button: #create-project-btn
- Cancel button: #cancel-btn

## Prerequisites
- Must be logged in with admin/admin
- Navigate via dashboard or directly to /projects

## Behaviour
- Modal opens when #new-project-btn is clicked
- Submitting with a name adds a new card to #project-list
- #success-msg appears for 3 seconds after successful creation
- Submitting without a name does nothing

## Test Scenarios
- create_project: Navigate to projects, click new project, fill name Delta, click create — verify #success-msg appears
- cancel_modal: Open modal then click cancel — modal should close with no project added