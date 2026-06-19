export const handleToolCall = async (toolName, args) => {
  if (toolName === 'clear_desk') {
    return { status: "success", message: "Workspace is reset, Jerome. What's next?" };
  }
  return { status: "error", message: "Unknown command" };
};
