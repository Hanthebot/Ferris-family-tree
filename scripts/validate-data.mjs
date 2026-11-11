#!/usr/bin/env node
/**
 * Validate the family-tree JSON and check that the generated JS mirror is current.
 * No dependencies; run with: node scripts/validate-data.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = path.join(root, 'data', 'family-tree.json');
const jsPath = path.join(root, 'data', 'family-tree.js');
const errors = [];
const warnings = [];

const jsonText = await readFile(jsonPath, 'utf8');
let data;
try {
  data = JSON.parse(jsonText);
} catch (error) {
  console.error(`Invalid JSON: ${error.message}`);
  process.exit(1);
}

const requiredMeta = ['title', 'subtitle', 'updated', 'description', 'scope'];
for (const key of requiredMeta) {
  if (!data.meta?.[key]) errors.push(`meta.${key} is required`);
}
if (data.meta?.updated && !/^\d{4}-\d{2}-\d{2}$/.test(data.meta.updated)) {
  errors.push('meta.updated must be YYYY-MM-DD');
}

if (!Array.isArray(data.nodes) || data.nodes.length === 0) errors.push('nodes must be a non-empty array');
if (!Array.isArray(data.links)) errors.push('links must be an array');

const ids = new Set();
const nodes = new Map();
for (const [index, node] of (data.nodes || []).entries()) {
  const where = `nodes[${index}]`;
  if (!node.id) errors.push(`${where}.id is required`);
  if (node.id && !/^[a-z0-9-]+$/.test(node.id)) errors.push(`${where}.id must be lowercase kebab-case`);
  if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
  ids.add(node.id);
  nodes.set(node.id, node);

  for (const key of ['name', 'maker', 'year', 'branch', 'summary', 'delta', 'evidence']) {
    if (!node[key]) errors.push(`${where} (${node.id || '?'}) is missing ${key}`);
  }
  if (!Array.isArray(node.changes) || node.changes.length === 0) {
    errors.push(`${where} (${node.id || '?'}) needs at least one change`);
  }
  if (!Array.isArray(node.tags) || node.tags.length === 0) {
    errors.push(`${where} (${node.id || '?'}) needs at least one tag`);
  }
  if (node.branch && !data.branches?.[node.branch]) {
    errors.push(`${where} (${node.id || '?'}) has unknown branch ${node.branch}`);
  }
  for (const tag of node.tags || []) {
    if (!data.tags?.[tag]) errors.push(`${where} (${node.id || '?'}) has unknown tag ${tag}`);
  }
  if (!node.source?.url || !node.source?.label) {
    errors.push(`${where} (${node.id || '?'}) needs source.label and source.url`);
  } else if (!/^https?:\/\//.test(node.source.url)) {
    errors.push(`${where} (${node.id || '?'}) source.url must be http(s)`);
  }
  if (!Number.isFinite(node.order)) warnings.push(`${where} (${node.id || '?'}) has no numeric order`);
}

const parentOf = new Map();
const children = new Map([...ids].map((id) => [id, []]));
let primaryCount = 0;

for (const [index, link] of (data.links || []).entries()) {
  const where = `links[${index}]`;
  if (!ids.has(link.from)) errors.push(`${where}.from is unknown: ${link.from}`);
  if (!ids.has(link.to)) errors.push(`${where}.to is unknown: ${link.to}`);
  if (link.from === link.to) errors.push(`${where} is a self-loop`);
  if (!['fork', 'variant', 'inspired', 'reuse'].includes(link.type)) {
    errors.push(`${where}.type must be fork, variant, inspired, or reuse`);
  }
  if (typeof link.primary !== 'boolean') errors.push(`${where}.primary must be boolean`);

  if (link.primary) {
    primaryCount += 1;
    if (parentOf.has(link.to)) errors.push(`${link.to} has more than one primary parent`);
    parentOf.set(link.to, link.from);
    children.get(link.from)?.push(link.to);
  } else if (link.type !== 'reuse') {
    warnings.push(`${where} is secondary but type is ${link.type}`);
  }

  if (!link.label) warnings.push(`${where} has no change label`);
}

const roots = [...ids].filter((id) => !parentOf.has(id));
if (roots.length !== 1) errors.push(`expected exactly one root, found ${roots.length}: ${roots.join(', ')}`);
if (primaryCount !== ids.size - 1) {
  errors.push(`expected ${ids.size - 1} primary links, found ${primaryCount}`);
}

// Cycle and depth check.
const visiting = new Set();
const visited = new Set();
let maxDepth = 0;
function walk(id, depth) {
  if (visiting.has(id)) {
    errors.push(`cycle detected at ${id}`);
    return;
  }
  if (visited.has(id)) return;
  visiting.add(id);
  maxDepth = Math.max(maxDepth, depth);
  for (const child of children.get(id) || []) walk(child, depth + 1);
  visiting.delete(id);
  visited.add(id);
}
for (const rootId of roots) walk(rootId, 0);
if (visited.size !== ids.size) errors.push(`${ids.size - visited.size} node(s) are disconnected from the root`);

for (const [index, filter] of (data.filters || []).entries()) {
  const where = `filters[${index}]`;
  if (!filter.id || !filter.label) errors.push(`${where} needs id and label`);
  if (!Array.isArray(filter.tags) || filter.tags.length === 0) errors.push(`${where} needs tags`);
  for (const tag of filter.tags || []) {
    if (!data.tags?.[tag]) errors.push(`${where} references unknown tag ${tag}`);
  }
}

// The generated mirror is what makes file:// work. It must match the JSON.
try {
  const mirror = await readFile(jsPath, 'utf8');
  const assignment = 'window.FAMILY_TREE_DATA = ';
  const start = mirror.indexOf(assignment);
  if (start < 0) {
    errors.push('data/family-tree.js is missing the FAMILY_TREE_DATA assignment');
  } else {
    const literal = mirror
      .slice(start + assignment.length)
      .trim()
      .replace(/;\s*$/, '');
    const mirrorData = JSON.parse(literal);
    if (JSON.stringify(mirrorData) !== JSON.stringify(data)) {
      errors.push('data/family-tree.js is stale; run node scripts/build-data.mjs');
    }
  }
} catch (error) {
  errors.push(`data/family-tree.js is missing or unreadable: ${error.message}`);
}

if (warnings.length) {
  console.log('Warnings:');
  for (const warning of warnings) console.log(`  ! ${warning}`);
}

if (errors.length) {
  console.error('Validation failed:');
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}

console.log(`Validated ${nodes.size} boards, ${primaryCount} primary links, ${data.links.length - primaryCount} secondary links.`);
console.log(`Root: ${roots[0]}; max generation: ${maxDepth + 1}.`);
