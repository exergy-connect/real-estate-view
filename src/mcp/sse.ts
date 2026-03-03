// Store active SSE sessions (in production, use Durable Objects or KV)
const activeSessions = new Map<string, {
  controller: ReadableStreamDefaultController;
  lastActivity: number;
}>();

/**
 * Clean up old sessions periodically
 */
export function cleanupSessions() {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.lastActivity > maxAge) {
      try {
        session.controller.close();
      } catch (e) {
        // Ignore errors when closing
      }
      activeSessions.delete(sessionId);
    }
  }
}

/**
 * Creates an SSE stream for MCP communication
 */
export function createSSEStream(sessionId: string, messagesUrl: string): ReadableStream {
  let controller: ReadableStreamDefaultController;
  
  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;
      activeSessions.set(sessionId, {
        controller: ctrl,
        lastActivity: Date.now()
      });
      
      // Send the endpoint event (required by MCP SSE protocol)
      const encoder = new TextEncoder();
      const endpointEvent = `event: endpoint\ndata: ${messagesUrl}\n\n`;
      ctrl.enqueue(encoder.encode(endpointEvent));
    },
    cancel() {
      activeSessions.delete(sessionId);
    }
  });
  
  return stream;
}

/**
 * Sends a message through an SSE stream
 */
export function sendSSEMessage(sessionId: string, message: any): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return false;
  }
  
  try {
    const encoder = new TextEncoder();
    const data = JSON.stringify(message);
    const sseMessage = `data: ${data}\n\n`;
    session.controller.enqueue(encoder.encode(sseMessage));
    session.lastActivity = Date.now();
    return true;
  } catch (error) {
    console.error('Error sending SSE message:', error);
    activeSessions.delete(sessionId);
    return false;
  }
}
