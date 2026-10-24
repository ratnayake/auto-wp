import type { ApprovalAction, ApprovalResult } from '@auto-wp/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from './container.js';

export class ApprovalRefused extends Error {
  override name = 'ApprovalRefused';
}

export interface ApprovalInput {
  action: ApprovalAction;
  siteId: string;
  summary: string;
  planHash: string;
  actor: string;
  /** Id of the tool request being served; routes the elicitation onto that request's response stream. */
  relatedRequestId?: string | number;
}

/** The user must type this to confirm; short enough to type, long enough that it is not rubber-stamped. */
export const confirmationCode = (planHash: string): string => planHash.slice(0, 8).toLowerCase();

const ELICIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Obtains human approval: MCP elicitation when the client supports it, else the injected ApprovalGate.
 * Throws ApprovalRefused when denied or when no approval path exists. Every outcome is audited.
 */
export async function requestApproval(
  services: Services,
  server: McpServer,
  input: ApprovalInput,
): Promise<ApprovalResult> {
  let result: ApprovalResult | undefined;
  let via = 'none';
  const at = () => services.clock.now().toISOString();

  if (server.server.getClientCapabilities()?.elicitation) {
    via = 'elicitation';
    const code = confirmationCode(input.planHash);
    try {
      const r = await server.server.elicitInput(
        {
          mode: 'form',
          message: `${input.summary}\n\nApproval required (${input.action} on ${input.siteId}). To confirm, type the first 8 characters of the plan hash: ${code}`,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: {
                type: 'string',
                title: 'Plan hash prefix',
                description: 'First 8 characters of the plan hash',
              },
            },
            required: ['confirm'],
          },
        },
        { relatedRequestId: input.relatedRequestId, timeout: ELICIT_TIMEOUT_MS },
      );
      const typed = typeof r.content?.confirm === 'string' ? r.content.confirm.trim().toLowerCase() : '';
      result = {
        approved: r.action === 'accept' && typed === code,
        by: `elicitation:${input.actor}`,
        planHash: input.planHash,
        at: at(),
      };
    } catch (err) {
      services.logger.warn({ err: String(err) }, 'elicitation failed; falling back to approval gate');
      via = 'none';
    }
  }
  if (!result && services.approvalGate) {
    via = 'gate';
    result = await services.approvalGate.request({
      action: input.action,
      siteId: input.siteId,
      summary: input.summary,
      planHash: input.planHash,
    });
  }

  await services.audit.append({
    ts: at(),
    actor: input.actor,
    siteId: input.siteId,
    action: 'approval',
    dryRun: false,
    data: { approvalFor: input.action, planHash: input.planHash, via, approved: result?.approved ?? false },
  });

  if (!result) {
    throw new ApprovalRefused(
      `${input.action} needs human approval but no approval path is available (client lacks MCP elicitation and no approval gate is configured). Refusing.`,
    );
  }
  if (!result.approved || result.planHash !== input.planHash) {
    throw new ApprovalRefused(`${input.action} was not approved.`);
  }
  return result;
}
