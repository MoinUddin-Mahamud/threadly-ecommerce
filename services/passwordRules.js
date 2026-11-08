'use strict';

// The most common passwords of eight or more characters.
const COMMON = new Set([
  '12345678', '123456789', '1234567890', '11111111', '00000000', '87654321', '12341234', '1q2w3e4r',
  '1qaz2wsx', 'qwertyui', 'qwerty123', 'qwertyuiop', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', 'abcd1234',
  'abc12345', 'abcdefgh', 'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd',
  'p@ssword', 'pa55word', 'letmein1', 'letmein123', 'welcome1', 'welcome123', 'iloveyou', 'iloveyou1',
  'admin123', 'admin1234', 'administrator', 'changeme', 'changeme123', 'football', 'baseball', 'superman',
  'trustno1', 'sunshine', 'princess', 'dragon12', 'monkey123', 'master123', 'shadow12', 'starwars',
  'whatever', 'freedom1', 'computer', 'internet'
]);

// One rule for every place a password is chosen (customers, staff, setup and the scripts). bcrypt
// reads only the first 72 bytes, so more is refused rather than silently cut off.
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be at most 72 bytes (about 72 letters and digits).';
  if (new Set(password).size === 1) return 'Password cannot be one character repeated.';
  if (COMMON.has(password.toLowerCase())) return 'That password is too common. Choose another one.';
  return null;
}

module.exports = { passwordProblem };
