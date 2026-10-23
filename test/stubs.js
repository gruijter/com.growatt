'use strict';

const Module = require('node:module');

/** Require `file` (an absolute path) with the modules named in `stubs` replaced by their value. */
module.exports = function requireStubbed(file, stubs) {
  const orig = Module._load;
  Module._load = function load(req, parent, isMain) {
    if (Object.hasOwn(stubs, req)) return stubs[req];
    return orig.call(this, req, parent, isMain);
  };
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(file);
  } finally {
    Module._load = orig;
  }
};
