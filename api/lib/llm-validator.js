export function validateLLMOutput(obj){
  // Lightweight validator for orchestrator structured output
  // Expected shape: { action: 'book'|'cancel'|'ask'|'route'|'none', params: object, speak: string, route_to?: string, task?: string }
  const errors = [];
  if(typeof obj !== 'object' || obj === null){ errors.push('output is not an object'); return { valid: false, errors }; }

  const { action, params, speak, route_to, task } = obj;
  const allowed = new Set(['book','cancel','ask','route','none']);
  if(typeof action !== 'string' || !allowed.has(action)) errors.push(`action must be one of ${[...allowed].join(',')}`);
  if(typeof params !== 'object' || params === null) errors.push('params must be an object');
  if(typeof speak !== 'string' || speak.trim().length === 0) errors.push('speak must be a non-empty string');
  if(route_to != null && (typeof route_to !== 'string' || !route_to.trim())) errors.push('route_to must be a non-empty string when present');
  if(task != null && typeof task !== 'string') errors.push('task must be a string when present');
  if(action === 'route' && (!route_to || typeof route_to !== 'string')) errors.push('route action requires route_to');

  return { valid: errors.length === 0, errors };
}
