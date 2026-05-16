-- KPI System Database Schema
-- Tables for managing organizational KPIs with role-based access

-- Employees table
CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  department VARCHAR(100) NOT NULL,
  role VARCHAR(50) NOT NULL CHECK (role IN ('staff', 'teamleader', 'manager', 'admin')),
  manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- KPI Definitions table (master list of available KPIs)
CREATE TABLE IF NOT EXISTS kpi_definitions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100) NOT NULL,
  department VARCHAR(100),
  target_value DECIMAL(10, 2) NOT NULL,
  unit VARCHAR(100),
  measurement_frequency VARCHAR(50) NOT NULL CHECK (measurement_frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'annual')),
  is_active BOOLEAN DEFAULT true,
  created_by INTEGER NOT NULL REFERENCES employees(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Employee KPI Assignments table
CREATE TABLE IF NOT EXISTS employee_kpi_assignments (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kpi_definition_id INTEGER NOT NULL REFERENCES kpi_definitions(id) ON DELETE CASCADE,
  assigned_date DATE NOT NULL,
  target_value DECIMAL(10, 2) NOT NULL,
  weight DECIMAL(3, 2) DEFAULT 1.0,
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(employee_id, kpi_definition_id)
);

-- KPI Progress Records table (daily/weekly/monthly entries)
CREATE TABLE IF NOT EXISTS kpi_progress (
  id SERIAL PRIMARY KEY,
  employee_kpi_assignment_id INTEGER NOT NULL REFERENCES employee_kpi_assignments(id) ON DELETE CASCADE,
  recorded_value DECIMAL(10, 2) NOT NULL,
  recorded_date DATE NOT NULL,
  notes TEXT,
  approved_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  approval_date TIMESTAMP,
  created_by INTEGER NOT NULL REFERENCES employees(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- KPI Review History table (for tracking changes and approvals)
CREATE TABLE IF NOT EXISTS kpi_review_history (
  id SERIAL PRIMARY KEY,
  employee_kpi_assignment_id INTEGER NOT NULL REFERENCES employee_kpi_assignments(id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL REFERENCES employees(id),
  review_period_start DATE NOT NULL,
  review_period_end DATE NOT NULL,
  achievement_percentage DECIMAL(5, 2),
  comments TEXT,
  status VARCHAR(50) CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX idx_employees_manager_id ON employees(manager_id);
CREATE INDEX idx_employees_department ON employees(department);
CREATE INDEX idx_employees_role ON employees(role);
CREATE INDEX idx_kpi_definitions_department ON kpi_definitions(department);
CREATE INDEX idx_employee_kpi_assignments_employee_id ON employee_kpi_assignments(employee_id);
CREATE INDEX idx_employee_kpi_assignments_status ON employee_kpi_assignments(status);
CREATE INDEX idx_kpi_progress_assignment_id ON kpi_progress(employee_kpi_assignment_id);
CREATE INDEX idx_kpi_progress_recorded_date ON kpi_progress(recorded_date);
CREATE INDEX idx_kpi_review_history_assignment_id ON kpi_review_history(employee_kpi_assignment_id);
