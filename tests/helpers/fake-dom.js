'use strict';
// A tiny document stand-in: one element per id found in index.html. Enough for the
// controller, which only uses getElementById, innerHTML, textContent, value, events and canvas.
const fs = require('node:fs');
const path = require('node:path');

class FakeCtx {
  constructor() { this.calls = []; }
}
['clearRect', 'beginPath', 'arc', 'fill', 'stroke', 'moveTo', 'lineTo', 'fillText', 'setLineDash'].forEach((m) => {
  FakeCtx.prototype[m] = function (...a) { this.calls.push([m, ...a]); };
});

class FakeElement {
  constructor(id, tag) {
    this.id = id;
    this.tagName = tag;
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.width = 760;
    this.height = 500;
    this.attrs = {};
    this.open = false;
    this.listeners = {};
    this.ctx = new FakeCtx();
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, evt) { (this.listeners[type] || []).forEach((fn) => fn(Object.assign({ target: this }, evt))); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  getContext() { return this.ctx; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  closest() { return this; }
}

function fakeTarget(dataset, disabled) {
  return { dataset, disabled: !!disabled, closest() { return this; } };
}

function createFakeDocument(htmlPath) {
  const html = fs.readFileSync(htmlPath || path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const els = {};
  const re = /<([a-z0-9]+)\b[^>]*\bid="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) els[m[2]] = new FakeElement(m[2], m[1].toUpperCase());
  return {
    els,
    getElementById(id) { return els[id] || null; }
  };
}

module.exports = { createFakeDocument, FakeElement, fakeTarget };
