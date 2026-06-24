/**
 * api/telnyx-advanced.js — Unified Endpoint for Advanced Telnyx Features
 * ═══════════════════════════════════════════════════════════════════════
 * Handles:
 * 1. RTP WebSocket Streaming (bi-directional audio)
 * 2. MCP Integration (native third-party tool access)
 * 3. Live In-Call MMS Vision (image processing during calls)
 */

import TelnyxRTPStream from './lib/telnyx-rtp-streaming.js';
import { executeMCPTool, buildMCPToolsPrompt } from './lib/telnyx-mcp-integration.js';
import {
  handleInCallMMS,
  getInCallMmsResult,
  buildMmsVisionPromptBlock
} from './lib/telnyx-live-mms-vision.js';

const activeStreams = new Map(); // callControlId -> TelnyxRTPStream instance

/**
 * POST /api/telnyx-advanced
 * Entry point for advanced Telnyx features
 * 
 * Routes to:
 * - ?action=rtp-stream → WebSocket RTP streaming
 * - ?action=mms-vision → In-call MMS vision processing
 * - ?action=mcp-tool → MCP tool execution
 */
export async function handler(req, res) {
  const action = req.query?.action || req.body?.action;

  try {
    switch (action) {
      case 'rtp-stream':
        return await handleRTPStream(req, res);

      case 'mms-vision':
        return await handleInCallMMS(req, res);

      case 'mcp-tool':
        return await handleMCPToolCall(req, res);

      case 'get-mms-result':
        return await getMmsResultForCall(req, res);

      case 'initialize-call':
        return await initializeAdvancedCall(req, res);

      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    console.error(`[ADVANCED] Error:`, e);
    return res.status(500).json({ error: e.message });
  }
}

/**
 * Handle RTP WebSocket stream initialization
 * Called when Telnyx routes inbound call with media_streaming=true
 */
async function handleRTPStream(req, res) {
  const { callControlId, tenantId, wsUrl } = req.body;

  try {
    // Create new RTP stream handler
    const stream = new TelnyxRTPStream(callControlId, tenantId);
    await stream.initialize(wsUrl);

    // Store active stream for later reference
    activeStreams.set(callControlId, stream);

    return res.status(200).json({
      success: true,
      streamId: callControlId,
      capabilities: ['full-duplex', 'sub-500ms-latency', 'barge-in', 'dtmf-detection']
    });
  } catch (e) {
    console.error(`[RTP] Initialization error:`, e);
    return res.status(500).json({ error: e.message });
  }
}

/**
 * Handle MCP tool calls from Lola's LLM
 * Intercept tool invocations and route to appropriate backend
 */
async function handleMCPToolCall(req, res) {
  const { toolName, params, tenantId, callControlId } = req.body;

  try {
    console.log(`[MCP] Executing tool: ${toolName}`, params);

    const result = await executeMCPTool(toolName, params, tenantId);

    // Log tool execution for audit trail
    await logToolExecution(tenantId, callControlId, toolName, params, result);

    return res.status(200).json({
      success: true,
      toolName,
      result
    });
  } catch (e) {
    console.error(`[MCP] Tool execution error:`, e);
    return res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * MMS vision result retrieval
 * Lola calls this mid-conversation to get analyzed image data
 */
async function getMmsResultForCall(req, res) {
  const { callControlId } = req.body;

  try {
    const mmsResult = getInCallMmsResult(callControlId);

    if (!mmsResult) {
      return res.status(200).json({ found: false });
    }

    return res.status(200).json({
      found: true,
      analysis: mmsResult.visionResult,
      promptBlock: buildMmsVisionPromptBlock(mmsResult)
    });
  } catch (e) {
    console.error(`[MMS] Retrieval error:`, e);
    return res.status(500).json({ error: e.message });
  }
}

/**
 * Initialize advanced features for a new call
 * Setup: RTP streaming, MCP tools, MMS vision capability
 */
async function initializeAdvancedCall(req, res) {
  const { callControlId, tenantId, phoneNumber } = req.body;

  try {
    // Check tenant capabilities
    const capabilities = {
      rtp_streaming: true, // Always available
      mcp_integration: true, // Always available
      live_mms_vision: true, // Always available
      depth_limit: 10,
      functions_enabled: [
        'calendar_check_availability',
        'calendar_create_booking',
        'stripe_charge_client',
        'crm_update_client',
        'slack_notify_team',
        'email_send_client',
        'sms_send_client',
        'analytics_get_metrics'
      ]
    };

    return res.status(200).json({
      initialized: true,
      callControlId,
      capabilities,
      systemPromptAdditions: [
        buildMCPToolsPrompt(),
        'Lola can process images sent via MMS during this call. If client sends a photo, it will be analyzed automatically.'
      ]
    });
  } catch (e) {
    console.error(`[ADVANCED] Init error:`, e);
    return res.status(500).json({ error: e.message });
  }
}

/**
 * Clean up stream when call ends
 */
export async function cleanupCall(callControlId) {
  const stream = activeStreams.get(callControlId);
  if (stream) {
    stream.stop();
    activeStreams.delete(callControlId);
    console.log(`[ADVANCED] Cleaned up call ${callControlId}`);
  }
}

/**
 * Audit logging for MCP tool calls
 */
async function logToolExecution(tenantId, callControlId, toolName, params, result) {
  try {
    // TODO: Store in audit database
    console.log(`[AUDIT] Tool executed: ${toolName} for tenant ${tenantId} call ${callControlId}`);
  } catch (e) {
    console.error(`[AUDIT] Logging failed:`, e);
  }
}

export default {
  handler,
  cleanupCall,
  activeStreams
};
