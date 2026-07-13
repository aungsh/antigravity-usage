import * as vscode from 'vscode';
import { ProcessDetector } from './services/processDetector';
import { QuotaClient } from './services/quotaClient';
import { ExtensionConfig } from './types';

export class AntigravityUsageProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antigravityUsageView';
    private _view?: vscode.WebviewView;
    private detector = new ProcessDetector();
    private client = new QuotaClient();

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        // Render initial loading state, then fetch data
        webviewView.webview.html = this.getLoadingHtml(webviewView.webview);
        this.updateData();
    }

    public async refresh() {
        if (this._view) {
            this._view.webview.html = this.getLoadingHtml(this._view.webview);
            this.detector.invalidateCache();
            await this.updateData();
        }
    }

    private async updateData() {
        if (!this._view) return;
        try {
            const config: ExtensionConfig = {
                pollingInterval: 60000,
                warningThreshold: 80,
                criticalThreshold: 90,
                enableNotifications: false,
                enableMockData: false
            };
            const connection = await this.detector.detect();
            const data = await this.client.fetchQuota(connection, config);
            this._view.webview.html = this.getHtmlForWebview(this._view.webview, data);
        } catch (e) {
            console.error('Failed to update data', e);
            if (this._view) {
                this._view.webview.html = `<h2>Error loading quota</h2><p>${e}</p>`;
            }
        }
    }

    private formatTimeUntil(ms?: number) {
        if (!ms) return 'N/A';
        const hours = Math.floor(ms / (1000 * 60 * 60));
        const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
        if (hours > 24) {
            const days = Math.floor(hours / 24);
            const rHours = hours % 24;
            return `${days}d ${rHours}h`;
        }
        return `${hours}h ${minutes}m`;
    }

    private getLoadingHtml(webview: vscode.Webview) {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Antigravity Usage</title>
</head>
<body>
    <h2>Antigravity Quota</h2>
    <div class="info-text">Fetching live data from language server...</div>
</body>
</html>`;
    }

    private getHtmlForWebview(webview: vscode.Webview, usageData: any) {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

        let groupsHtml = '';
        
        // Group models intelligently based on tier if possible, or just list them all.
        // The API returns models grouped by the current cascade Model Config Data.
        // But for our UI, we want to maintain the "Groups" look. 
        // Let's separate Gemini vs Claude as the user requested if they exist.
        const geminiModels = usageData.models.filter((m: any) => m.modelId.toLowerCase().includes('gemini'));
        const claudeModels = usageData.models.filter((m: any) => m.modelId.toLowerCase().includes('claude') || m.modelId.toLowerCase().includes('gpt'));
        
        const renderGroup = (name: string, models: any[]) => {
            if (models.length === 0) return '';
            
            // Just use the first model's reset time since they share buckets
            const sampleModel = models[0];
            const remainingPercent = (sampleModel.remainingFraction * 100).toFixed(2);
            const usedPercent = Math.min(100, (1 - sampleModel.remainingFraction) * 100);
            
            // To emulate the 5-hour and Weekly limits look we had, we would need bucket-level data.
            // But the reference API only returns one `remainingFraction` per model.
            // We will just show "Usage Limit" for the model group.
            const modelNames = models.map((m: any) => m.modelName || m.label).join(', ');

            return `
    <div class="group-container">
        <h3>${name}</h3>
        <p class="model-list">Models: ${modelNames}</p>
        
        <div class="limit-label">
            <span>Usage Limit</span>
            <span class="percentage ${usedPercent > 80 ? 'danger' : 'safe'}">${remainingPercent}% remaining</span>
        </div>
        <div class="progress-container">
            <div class="progress-fill" style="width: ${usedPercent}%;"></div>
        </div>
        <div class="progress-details">
            <span>${sampleModel.isExhausted ? 'Exhausted' : 'Active'}</span>
            <span>Refreshes in: ${this.formatTimeUntil(sampleModel.timeUntilResetMs)}</span>
        </div>
    </div>`;
        };

        groupsHtml += renderGroup('Gemini Models', geminiModels);
        groupsHtml += renderGroup('Claude and GPT Models', claudeModels);
        
        // If neither matched (or there are leftovers), render them in an "Other Models" group
        const otherModels = usageData.models.filter((m: any) => !m.modelId.toLowerCase().includes('gemini') && !m.modelId.toLowerCase().includes('claude') && !m.modelId.toLowerCase().includes('gpt'));
        groupsHtml += renderGroup('Other Models', otherModels);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Antigravity Usage</title>
</head>
<body>
    <h2>Antigravity Quota</h2>
    
    ${usageData.status === 'disconnected' ? '<div class="info-text">Not connected to Language Server. Is Antigravity running?</div>' : groupsHtml}

    <div class="info-text">
        * Data fetched live from local Antigravity Language Server RPC.
    </div>
</body>
</html>`;
    }
}
