export function validateLLMOutput(obj){
  // Lightweight validator for orchestrator structured output
  // Expected shape: { action: 'book'|'cancel'|'ask'|'none', params: object, speak: string }
  const errors = [];
  if(typeof obj !== 'object' || obj === null){ errors.push('output is not an object'); return { valid: false, errors }; }

  const { action, params, speak } = obj;
  const allowed = new Set(['book','cancel','ask','none']);
  if(typeof action !== 'string' || !allowed.has(action)) errors.push(`action must be one of ${[...allowed].join(',')}`);
  if(typeof params !== 'object' || params === null) errors.push('params must be an object');
  if(typeof speak !== 'string' || speak.trim().length === 0) errors.push('speak must be a non-empty string');

  return { valid: errors.length === 0, errors };
}
