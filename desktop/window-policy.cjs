"use strict";

function getUrlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isInternalUrl(value, appOrigin) {
  return getUrlOrigin(value) === appOrigin;
}

function isSafeExternalUrl(value) {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

module.exports = { getUrlOrigin, isInternalUrl, isSafeExternalUrl };
