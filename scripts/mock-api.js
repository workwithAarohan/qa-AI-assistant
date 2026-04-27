/**
 * mock-api.js — DataApp Mock API
 *
 * Serves employee data with realistic field types.
 * Mounted at /api/dataapp/* by the main server.
 *
 * Endpoints:
 *   GET /api/dataapp/employees         → all employees (array)
 *   GET /api/dataapp/employees/:id     → single employee
 *   GET /api/dataapp/employees/summary → dept counts + total salary
 *   POST /api/dataapp/validate         → validate a field payload server-side
 */

import { Router } from 'express';

const router = Router();

// ── Seed data ────────────────────────────────────────────────────────────────
// 50 employees with realistic variation for filter/sort/pagination testing.
// Intentionally includes: salary range, mixed departments, past/future dates,
// mixed status — so data validation tests have meaningful assertions.

function makeEmployee(id, name, email, dept, role, salary, startDate, status) {
  return { id, name, email, department: dept, role, salary, start_date: startDate, status };
}

const EMPLOYEES = [
  makeEmployee(1,  'Alice Johnson',    'alice@company.com',    'Engineering', 'Senior Engineer',  120000, '2021-03-15', 'Active'),
  makeEmployee(2,  'Bob Martinez',     'bob@company.com',      'QA',          'QA Lead',           95000, '2020-08-01', 'Active'),
  makeEmployee(3,  'Carol Chen',       'carol@company.com',    'Product',     'Product Manager',  110000, '2019-11-20', 'Active'),
  makeEmployee(4,  'David Kim',        'david@company.com',    'Design',      'UX Designer',       88000, '2022-01-10', 'Active'),
  makeEmployee(5,  'Eva Patel',        'eva@company.com',      'Engineering', 'Staff Engineer',   145000, '2018-06-01', 'Active'),
  makeEmployee(6,  'Frank Liu',        'frank@company.com',    'Engineering', 'Junior Engineer',   72000, '2023-07-15', 'Active'),
  makeEmployee(7,  'Grace Okafor',     'grace@company.com',    'QA',          'QA Engineer',       82000, '2021-09-01', 'Active'),
  makeEmployee(8,  'Henry Brown',      'henry@company.com',    'Product',     'Product Owner',    105000, '2020-04-12', 'Inactive'),
  makeEmployee(9,  'Iris Yamamoto',    'iris@company.com',     'Design',      'Design Lead',       98000, '2019-03-28', 'Active'),
  makeEmployee(10, 'James Wilson',     'james@company.com',    'Engineering', 'DevOps Engineer',  115000, '2021-12-01', 'Active'),
  makeEmployee(11, 'Karen Scott',      'karen@company.com',    'Engineering', 'Backend Engineer', 108000, '2020-07-20', 'Active'),
  makeEmployee(12, 'Liam Nguyen',      'liam@company.com',     'QA',          'Automation QA',     90000, '2022-03-05', 'Active'),
  makeEmployee(13, 'Mia Rossi',        'mia@company.com',      'Product',     'Senior PM',        125000, '2017-09-10', 'Active'),
  makeEmployee(14, 'Noah Taylor',      'noah@company.com',     'Design',      'Visual Designer',   79000, '2023-01-16', 'Active'),
  makeEmployee(15, 'Olivia White',     'olivia@company.com',   'Engineering', 'Frontend Engineer', 97000, '2021-05-31', 'Active'),
  makeEmployee(16, 'Paul Garcia',      'paul@company.com',     'Engineering', 'Security Engineer',118000, '2020-02-14', 'Inactive'),
  makeEmployee(17, 'Quinn Moore',      'quinn@company.com',    'QA',          'Performance QA',    86000, '2022-08-22', 'Active'),
  makeEmployee(18, 'Rachel Davis',     'rachel@company.com',   'Product',     'Associate PM',      84000, '2023-04-03', 'Active'),
  makeEmployee(19, 'Sam Anderson',     'sam@company.com',      'Design',      'Motion Designer',   83000, '2022-11-07', 'Active'),
  makeEmployee(20, 'Tina Jackson',     'tina@company.com',     'Engineering', 'ML Engineer',      132000, '2019-08-19', 'Active'),
  makeEmployee(21, 'Uma Hernandez',    'uma@company.com',      'Engineering', 'Platform Engineer',122000, '2020-10-27', 'Active'),
  makeEmployee(22, 'Victor Lee',       'victor@company.com',   'QA',          'QA Manager',       105000, '2018-12-03', 'Active'),
  makeEmployee(23, 'Wendy Clark',      'wendy@company.com',    'Product',     'Product Designer',  91000, '2021-07-14', 'Active'),
  makeEmployee(24, 'Xander Lewis',     'xander@company.com',   'Design',      'Brand Designer',    76000, '2023-02-28', 'Inactive'),
  makeEmployee(25, 'Yuki Robinson',    'yuki@company.com',     'Engineering', 'Data Engineer',    113000, '2020-05-18', 'Active'),
  makeEmployee(26, 'Zara Walker',      'zara@company.com',     'Engineering', 'Cloud Architect',  155000, '2016-04-01', 'Active'),
  makeEmployee(27, 'Aaron Hall',       'aaron@company.com',    'QA',          'Security QA',       93000, '2022-06-09', 'Active'),
  makeEmployee(28, 'Bella Allen',      'bella@company.com',    'Product',     'Growth PM',        116000, '2019-01-21', 'Active'),
  makeEmployee(29, 'Carlos Young',     'carlos@company.com',   'Design',      'Product Designer',  87000, '2021-10-12', 'Active'),
  makeEmployee(30, 'Diana King',       'diana@company.com',    'Engineering', 'Embedded Engineer', 99000, '2020-09-05', 'Inactive'),
  makeEmployee(31, 'Ethan Wright',     'ethan@company.com',    'Engineering', 'Senior Engineer',  128000, '2018-03-22', 'Active'),
  makeEmployee(32, 'Fiona Scott',      'fiona@company.com',    'QA',          'Mobile QA',         80000, '2023-05-01', 'Active'),
  makeEmployee(33, 'George Torres',    'george@company.com',   'Product',     'VP Product',       185000, '2015-11-15', 'Active'),
  makeEmployee(34, 'Hannah Adams',     'hannah@company.com',   'Design',      'Research Designer', 94000, '2020-12-07', 'Active'),
  makeEmployee(35, 'Ian Baker',        'ian@company.com',      'Engineering', 'Infra Engineer',   109000, '2021-02-19', 'Active'),
  makeEmployee(36, 'Julia Gonzalez',   'julia@company.com',    'Engineering', 'SRE',              135000, '2019-06-30', 'Active'),
  makeEmployee(37, 'Kevin Perez',      'kevin@company.com',    'QA',          'API Tester',        78000, '2022-09-14', 'Active'),
  makeEmployee(38, 'Laura Sanchez',    'laura@company.com',    'Product',     'Technical PM',     119000, '2018-07-08', 'Active'),
  makeEmployee(39, 'Marco Rivera',     'marco@company.com',    'Design',      'Icon Designer',     71000, '2023-03-20', 'Active'),
  makeEmployee(40, 'Nadia Phillips',   'nadia@company.com',    'Engineering', 'API Engineer',     103000, '2020-11-11', 'Active'),
  makeEmployee(41, 'Oscar Campbell',   'oscar@company.com',    'Engineering', 'Junior Engineer',   68000, '2024-01-08', 'Active'),
  makeEmployee(42, 'Priya Parker',     'priya@company.com',    'QA',          'Test Lead',         92000, '2021-04-26', 'Active'),
  makeEmployee(43, 'Raj Evans',        'raj@company.com',      'Product',     'Product Analyst',   87000, '2022-02-14', 'Active'),
  makeEmployee(44, 'Sofia Edwards',    'sofia@company.com',    'Design',      'UI Designer',       82000, '2021-08-30', 'Active'),
  makeEmployee(45, 'Tom Collins',      'tom@company.com',      'Engineering', 'Staff Engineer',   142000, '2017-05-16', 'Inactive'),
  makeEmployee(46, 'Uma Stewart',      'uma2@company.com',     'Engineering', 'Data Scientist',   138000, '2019-10-01', 'Active'),
  makeEmployee(47, 'Vera Morris',      'vera@company.com',     'QA',          'QA Analyst',        75000, '2023-06-05', 'Active'),
  makeEmployee(48, 'Will Rogers',      'will@company.com',     'Product',     'CPO',              220000, '2014-02-01', 'Active'),
  makeEmployee(49, 'Xena Reed',        'xena@company.com',     'Design',      'Creative Director',130000, '2016-09-12', 'Active'),
  makeEmployee(50, 'Yasmin Cook',      'yasmin@company.com',   'Engineering', 'DevEx Engineer',    111000, '2020-03-25', 'Active'),
];

// ── Routes ───────────────────────────────────────────────────────────────────

router.get('/employees', (req, res) => {
  // Simulate a 150ms network delay (realistic API behaviour)
  setTimeout(() => {
    res.json(EMPLOYEES);
  }, 150);
});

router.get('/employees/summary', (req, res) => {
  const depts = {};
  let totalSalary = 0, activeCount = 0;
  EMPLOYEES.forEach(e => {
    depts[e.department] = (depts[e.department] || 0) + 1;
    totalSalary += e.salary;
    if (e.status === 'Active') activeCount++;
  });
  res.json({
    total: EMPLOYEES.length,
    active: activeCount,
    inactive: EMPLOYEES.length - activeCount,
    totalSalary,
    avgSalary: Math.round(totalSalary / EMPLOYEES.length),
    byDepartment: depts,
  });
});

router.get('/employees/:id', (req, res) => {
  const emp = EMPLOYEES.find(e => e.id === parseInt(req.params.id));
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  res.json(emp);
});

// Server-side validation endpoint (used by API testing runner)
router.post('/validate', (req, res) => {
  const { name, email, phone, department, start_date } = req.body || {};
  const errors = [];

  if (!name || name.trim().length < 3)
    errors.push({ field: 'name', message: 'Name must be at least 3 characters' });

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    errors.push({ field: 'email', message: 'Invalid email format' });

  if (phone && !/^\d{3}-\d{3}-\d{4}$/.test(phone.trim()))
    errors.push({ field: 'phone', message: 'Phone must match XXX-XXX-XXXX' });

  if (!department || !['Engineering','QA','Product','Design'].includes(department))
    errors.push({ field: 'department', message: 'Invalid department' });

  if (!start_date || new Date(start_date) < new Date(new Date().toDateString()))
    errors.push({ field: 'start_date', message: 'Start date cannot be in the past' });

  res.status(errors.length ? 422 : 200).json({ valid: errors.length === 0, errors });
});

export default router;
export { EMPLOYEES };