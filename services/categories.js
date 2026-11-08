const CATEGORIES = ['Men', 'Women', 'Kids', 'Accessories'];

// "women" and " Women " both give "Women"; anything else gives null.
function canonicalCategory(value) {
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  return CATEGORIES.find((c) => c.toLowerCase() === text) || null;
}

const CATEGORY_MESSAGE = `Category must be one of: ${CATEGORIES.join(', ')}.`;

module.exports = { CATEGORIES, canonicalCategory, CATEGORY_MESSAGE };
