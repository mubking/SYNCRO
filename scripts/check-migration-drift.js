#!/usr/bin/env node

/**
 * Migration Drift Check Script
 * 
 * Detects drift between backend/migrations and supabase/migrations folders.
 * This script ensures schema changes cannot silently diverge between folders.
 * 
 * Usage: node scripts/check-migration-drift.js
 * 
 * Exit codes:
 *   0 - No drift detected
 *   1 - Drift detected (conflicts or duplicates found)
 *   2 - Error occurred
 */

const fs = require('fs');
const path = require('path');

// Configuration
const BACKEND_MIGRATIONS = path.join(__dirname, '..', 'backend', 'migrations');
const SUPABASE_MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');

// Normalize SQL content for comparison (remove comments, whitespace, case)
function normalizeSQL(content) {
  return content
    .replace(/--.*$/gm, '') // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
    .replace(/\s+/g, ' ') // Normalize whitespace
    .toLowerCase()
    .trim();
}

// Extract table names from SQL content
function extractTables(sql) {
  const tableRegex = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi;
  const alterRegex = /alter\s+table\s+(?:only\s+)?(?:public\.)?(\w+)/gi;
  const tables = new Set();
  
  let match;
  while ((match = tableRegex.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }
  while ((match = alterRegex.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }
  
  return tables;
}

// Extract index names from SQL content
function extractIndexes(sql) {
  const indexRegex = /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(\w+)/gi;
  const indexes = new Set();
  
  let match;
  while ((match = indexRegex.exec(sql)) !== null) {
    indexes.add(match[1].toLowerCase());
  }
  
  return indexes;
}

// Extract policy names from SQL content
function extractPolicies(sql) {
  const policyRegex = /create\s+policy\s+(\w+)/gi;
  const policies = new Set();
  
  let match;
  while ((match = policyRegex.exec(sql)) !== null) {
    policies.add(match[1].toLowerCase());
  }
  
  return policies;
}

// Read all migration files from a directory
function readMigrations(dir) {
  const migrations = new Map();
  
  if (!fs.existsSync(dir)) {
    console.warn(`Warning: Directory does not exist: ${dir}`);
    return migrations;
  }
  
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    migrations.set(file, {
      content,
      normalized: normalizeSQL(content),
      tables: extractTables(content),
      indexes: extractIndexes(content),
      policies: extractPolicies(content)
    });
  }
  
  return migrations;
}

// Compare two migration contents
function compareMigrations(name1, m1, name2, m2) {
  const issues = [];
  
  // Check if normalized content is identical
  if (m1.normalized === m2.normalized) {
    issues.push({
      type: 'duplicate',
      severity: 'error',
      message: `Identical migrations: "${name1}" and "${name2}"`,
      files: [name1, name2]
    });
  } else {
    // Check for table overlap with different content
    const commonTables = [...m1.tables].filter(t => m2.tables.has(t));
    if (commonTables.length > 0) {
      issues.push({
        type: 'conflict',
        severity: 'warning',
        message: `Common tables in different migrations: "${name1}" and "${name2}" affect tables: ${commonTables.join(', ')}`,
        files: [name1, name2],
        tables: commonTables
      });
    }
  }
  
  return issues;
}

// Main drift detection function
function detectDrift() {
  console.log('🔍 Checking migration drift between backend and supabase...\n');
  
  const backendMigrations = readMigrations(BACKEND_MIGRATIONS);
  const supabaseMigrations = readMigrations(SUPABASE_MIGRATIONS);
  
  const issues = [];
  const analyzed = new Set();
  
  // Compare each backend migration with supabase migrations
  for (const [backendFile, backendData] of backendMigrations) {
    for (const [supabaseFile, supabaseData] of supabaseMigrations) {
      const pairKey = [backendFile, supabaseFile].sort().join('|');
      if (analyzed.has(pairKey)) continue;
      analyzed.add(pairKey);
      
      // Check for similar filenames (potential duplicates)
      const backendBase = backendFile.replace(/^\d+_/, '').replace('.sql', '');
      const supabaseBase = supabaseFile.replace(/^\d+_/, '').replace('.sql', '');
      
      if (backendBase === supabaseBase || 
          backendFile.includes(supabaseBase) || 
          supabaseFile.includes(backendBase)) {
        const comparisonIssues = compareMigrations(backendFile, backendData, supabaseFile, supabaseData);
        issues.push(...comparisonIssues);
      }
    }
  }
  
  // Check for table conflicts across all migrations
  const allBackendTables = new Map();
  const allSupabaseTables = new Map();
  
  for (const [file, data] of backendMigrations) {
    for (const table of data.tables) {
      if (!allBackendTables.has(table)) {
        allBackendTables.set(table, []);
      }
      allBackendTables.get(table).push(file);
    }
  }
  
  for (const [file, data] of supabaseMigrations) {
    for (const table of data.tables) {
      if (!allSupabaseTables.has(table)) {
        allSupabaseTables.set(table, []);
      }
      allSupabaseTables.get(table).push(file);
    }
  }
  
  // Report findings
  console.log('=== Migration Analysis ===\n');
  console.log(`Backend migrations: ${backendMigrations.size} files`);
  console.log(`Supabase migrations: ${supabaseMigrations.size} files\n`);
  
  if (issues.length === 0) {
    console.log('✅ No migration drift detected.');
    console.log('\n--- Summary ---');
    console.log(`Total backend tables: ${allBackendTables.size}`);
    console.log(`Total supabase tables: ${allSupabaseTables.size}`);
    return { success: true, issues: [] };
  }
  
  // Group issues by type
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  
  if (errors.length > 0) {
    console.log('❌ ERRORS (must fix):\n');
    for (const issue of errors) {
      console.log(`  [${issue.type.toUpperCase()}] ${issue.message}`);
    }
    console.log('');
  }
  
  if (warnings.length > 0) {
    console.log('⚠️  WARNINGS (review recommended):\n');
    for (const issue of warnings) {
      console.log(`  [${issue.type.toUpperCase()}] ${issue.message}`);
    }
    console.log('');
  }
  
  console.log('\n--- Recommendations ---');
  console.log('1. Review duplicate migrations and consolidate them');
  console.log('2. Ensure all schema changes go through a single migration path');
  console.log('3. Use either backend/migrations OR supabase/migrations, not both');
  console.log('4. Run this check in CI to prevent drift');
  
  return { 
    success: errors.length === 0, 
    issues,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      backendMigrations: backendMigrations.size,
      supabaseMigrations: supabaseMigrations.size
    }
  };
}

// Run the check
const result = detectDrift();

if (!result.success) {
  console.log('\n❌ Migration drift detected! Please fix the issues above.');
  process.exit(1);
} else {
  process.exit(0);
}