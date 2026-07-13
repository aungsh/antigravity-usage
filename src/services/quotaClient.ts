/**
 * Adapted from https://github.com/Henrik-3/AntigravityQuota (MIT License)
 * 
 * Quota client — fetches quota data from the local Antigravity Language Server
 * or falls back to mock data for development.
 */

import { ConnectionInfo, ExtensionConfig, ModelQuota, QuotaSnapshot, QuotaStatus, SubscriptionTier, PromptCredits, ServerUserStatusResponse } from '../types';
import { ConnectClient } from './connectClient';
import { getQuotaStatus } from '../utils/formatting';

export class QuotaClient {
    private connectClient = new ConnectClient();

    /**
     * Fetch quota data. Tries the live Language Server first, falls back to mock.
     */
    async fetchQuota(
        connection: ConnectionInfo | null,
        config: ExtensionConfig
    ): Promise<QuotaSnapshot> {
        // Mock data shortcut
        if (config.enableMockData) {
            return this.getMockSnapshot(config);
        }

        // No connection — disconnected
        if (!connection) {
            return this.getDisconnectedSnapshot();
        }

        // Query the live Language Server
        try {
            const protocol = connection.isHttps ? 'https' : 'http';
            const baseUrl = `${protocol}://127.0.0.1:${connection.port}`;
            const data = await this.connectClient.getUserStatus(baseUrl, connection.authToken);
            return this.parseResponse(data, config);
        } catch (error) {
            console.error('[Antigravity Usage Monitor] Connect RPC error:', error);
            return this.getDisconnectedSnapshot();
        }
    }

    private getQuotaInfo(model: any): any | undefined {
        return model.quotaInfo ?? model.quota_info;
    }

    private parseResponse(data: ServerUserStatusResponse, config: ExtensionConfig): QuotaSnapshot {
        const userStatus = data.userStatus;
        if (!userStatus) {
            return this.getDisconnectedSnapshot();
        }

        const planInfo = userStatus.planStatus?.planInfo;
        const availableCredits = userStatus.planStatus?.availablePromptCredits;

        let promptCredits: PromptCredits | undefined;

        if (planInfo && availableCredits !== undefined) {
            const monthly = Number(planInfo.monthlyPromptCredits);
            const available = Number(availableCredits);
            if (monthly > 0) {
                promptCredits = {
                    available: available,
                    limit: monthly,
                    used: monthly - available,
                    remaining: available
                } as PromptCredits;
            }
        }

        const rawModels = userStatus.cascadeModelConfigData?.clientModelConfigs || [];

        const models: ModelQuota[] = rawModels.map((m: any) => {
            const quotaInfo = this.getQuotaInfo(m);
            const resetTimeRaw = quotaInfo?.resetTime ?? quotaInfo?.reset_time;
            const resetTime = resetTimeRaw ? new Date(resetTimeRaw) : new Date(0);
            const now = new Date();
            const timeUntilResetMs = resetTime.getTime() - now.getTime();
            
            const remainingFraction = quotaInfo?.remainingFraction ?? quotaInfo?.remaining_fraction ?? 1.0;
            const isExhausted = m.isExhausted ?? (remainingFraction === 0);
            
            const usedFraction = 1 - remainingFraction;
            const percentUsed = Math.round(usedFraction * 100);

            return {
                modelId: m.modelOrAlias?.model ?? m.model_or_alias?.model ?? 'unknown',
                modelName: m.label ?? m.displayName ?? 'Unknown',
                used: percentUsed,
                limit: 100,
                percentUsed,
                resetTimestamp: resetTime.getTime(),
                remainingFraction,
                isExhausted,
                timeUntilResetMs: timeUntilResetMs > 0 ? timeUntilResetMs : 0
            };
        });

        // Sort models by name
        models.sort((a, b) => a.modelName.localeCompare(b.modelName));

        // Overall usage: average of all models
        const overallPercent = models.length > 0
            ? Math.round(models.reduce((sum, m) => sum + m.percentUsed, 0) / models.length)
            : 0;

        const status = getQuotaStatus(overallPercent, config.warningThreshold, config.criticalThreshold);

        // Determine subscription tier
        let tier = SubscriptionTier.UNKNOWN;
        const tierName = planInfo?.planName || planInfo?.teamsTier;
        if (tierName) {
            if (tierName.includes('Ultra')) { tier = SubscriptionTier.ULTRA; }
            else if (tierName.includes('Pro')) { tier = SubscriptionTier.PRO; }
            else if (tierName.includes('Free')) { tier = SubscriptionTier.FREE; }
        }

        return {
            models,
            overallPercent,
            status,
            lastUpdated: Date.now(),
            subscriptionTier: tier,
            promptCredits,
            email: userStatus.email,
            source: 'local',
        };
    }

    /**
     * Return a disconnected snapshot when no Language Server is found.
     */
    private getDisconnectedSnapshot(): QuotaSnapshot {
        return {
            models: [],
            overallPercent: 0,
            status: QuotaStatus.DISCONNECTED,
            lastUpdated: Date.now(),
            subscriptionTier: SubscriptionTier.UNKNOWN,
            source: 'disconnected',
        };
    }

    /**
     * Return realistic mock data for development & testing.
     */
    private getMockSnapshot(config: ExtensionConfig): QuotaSnapshot {
        const now = Date.now();
        const resetIn2h = now + 2 * 60 * 60 * 1000;
        const resetIn4h = now + 4 * 60 * 60 * 1000;

        const models: ModelQuota[] = [
            {
                modelId: 'gemini-3-pro-high',
                modelName: 'Gemini 3 Pro (High)',
                used: 37,
                limit: 100,
                percentUsed: 37,
                resetTimestamp: resetIn4h,
                remainingFraction: 0.63,
                isExhausted: false,
                timeUntilResetMs: 4 * 60 * 60 * 1000
            },
            {
                modelId: 'gemini-3-pro-low',
                modelName: 'Gemini 3 Pro (Low)',
                used: 12,
                limit: 100,
                percentUsed: 12,
                resetTimestamp: resetIn4h,
                remainingFraction: 0.88,
                isExhausted: false,
                timeUntilResetMs: 4 * 60 * 60 * 1000
            },
            {
                modelId: 'gemini-3-flash',
                modelName: 'Gemini 3 Flash',
                used: 5,
                limit: 100,
                percentUsed: 5,
                resetTimestamp: resetIn4h,
                remainingFraction: 0.95,
                isExhausted: false,
                timeUntilResetMs: 4 * 60 * 60 * 1000
            },
            {
                modelId: 'claude-sonnet-4.5',
                modelName: 'Claude Sonnet 4.5',
                used: 62,
                limit: 100,
                percentUsed: 62,
                resetTimestamp: resetIn2h,
                remainingFraction: 0.38,
                isExhausted: false,
                timeUntilResetMs: 2 * 60 * 60 * 1000
            },
            {
                modelId: 'claude-sonnet-4.5-thinking',
                modelName: 'Claude Sonnet 4.5 (Thinking)',
                used: 78,
                limit: 100,
                percentUsed: 78,
                resetTimestamp: resetIn2h,
                remainingFraction: 0.22,
                isExhausted: false,
                timeUntilResetMs: 2 * 60 * 60 * 1000
            },
            {
                modelId: 'claude-opus-4.5-thinking',
                modelName: 'Claude Opus 4.5 (Thinking)',
                used: 91,
                limit: 100,
                percentUsed: 91,
                resetTimestamp: resetIn2h,
                remainingFraction: 0.09,
                isExhausted: false,
                timeUntilResetMs: 2 * 60 * 60 * 1000
            },
            {
                modelId: 'claude-opus-4.6-thinking',
                modelName: 'Claude Opus 4.6 (Thinking)',
                used: 45,
                limit: 100,
                percentUsed: 45,
                resetTimestamp: resetIn2h,
                remainingFraction: 0.55,
                isExhausted: false,
                timeUntilResetMs: 2 * 60 * 60 * 1000
            },
            {
                modelId: 'gpt-oss-120b',
                modelName: 'GPT-OSS 120B (Medium)',
                used: 20,
                limit: 100,
                percentUsed: 20,
                resetTimestamp: resetIn4h,
                remainingFraction: 0.80,
                isExhausted: false,
                timeUntilResetMs: 4 * 60 * 60 * 1000
            },
        ];

        const overallPercent = Math.round(
            models.reduce((sum, m) => sum + m.percentUsed, 0) / models.length
        );

        return {
            models,
            overallPercent,
            status: getQuotaStatus(overallPercent, config.warningThreshold, config.criticalThreshold),
            lastUpdated: now,
            subscriptionTier: SubscriptionTier.PRO,
            promptCredits: { used: 250, limit: 500, remaining: 250 },
            email: 'user@example.com',
            source: 'mock',
        };
    }
}
