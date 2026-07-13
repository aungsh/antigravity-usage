import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class AntigravityUsageProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antigravityUsageView';
    private _view?: vscode.WebviewView;

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

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    }

    public refresh() {
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview(this._view.webview);
        }
    }

    private getUsageData() {
        const defaultData = {
            groups: [
                {
                    name: "Gemini Models",
                    models: "Gemini Flash, Gemini Pro",
                    weeklyTokensUsed: 0,
                    weeklyTokensLimit: 100000,
                    fiveHourTokensUsed: 0,
                    fiveHourTokensLimit: 20000
                },
                {
                    name: "Claude and GPT Models",
                    models: "Claude Opus, Claude Sonnet, GPT-OSS",
                    weeklyTokensUsed: 0,
                    weeklyTokensLimit: 100000,
                    fiveHourTokensUsed: 0,
                    fiveHourTokensLimit: 20000
                }
            ]
        };

        try {
            const configPath = path.join(os.homedir(), '.gemini', 'antigravity-usage.json');
            if (fs.existsSync(configPath)) {
                const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (data.groups) {
                    return data;
                } else {
                    return {
                        groups: [
                            {
                                name: "Gemini Models",
                                models: "Legacy Data",
                                ...data
                            }
                        ]
                    };
                }
            }
        } catch (e) {
            console.error('Failed to read usage data', e);
        }
        return defaultData;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
        const usageData = this.getUsageData();

        let groupsHtml = '';
        for (const group of usageData.groups) {
            const weeklyRemainingPercent = (Math.max(0, 100 - (group.weeklyTokensUsed / group.weeklyTokensLimit) * 100)).toFixed(2);
            const fiveHourRemainingPercent = (Math.max(0, 100 - (group.fiveHourTokensUsed / group.fiveHourTokensLimit) * 100)).toFixed(2);
            const weeklyUsedPercent = Math.min(100, (group.weeklyTokensUsed / group.weeklyTokensLimit) * 100);
            const fiveHourUsedPercent = Math.min(100, (group.fiveHourTokensUsed / group.fiveHourTokensLimit) * 100);

            const weeklyRemaining = group.weeklyTokensLimit - group.weeklyTokensUsed;
            const fiveHourRemaining = group.fiveHourTokensLimit - group.fiveHourTokensUsed;

            groupsHtml += `
    <div class="group-container">
        <h3>${group.name}</h3>
        <p class="model-list">Models: ${group.models}</p>
        
        <div class="card">
            <div class="card-header">
                <span class="card-title">5-Hour Limit</span>
                <span class="card-status ${fiveHourUsedPercent > 80 ? 'danger' : 'safe'}">${fiveHourRemainingPercent}% remaining</span>
            </div>
            <div class="progress-container">
                <div class="progress-fill" style="width: ${fiveHourUsedPercent}%;"></div>
            </div>
            <div class="card-stats">
                <span>Used: <strong>${group.fiveHourTokensUsed.toLocaleString()}</strong></span>
                <span>Left: <strong>${fiveHourRemaining.toLocaleString()}</strong></span>
            </div>
        </div>

        <div class="card">
            <div class="card-header">
                <span class="card-title">Weekly Limit</span>
                <span class="card-status ${weeklyUsedPercent > 80 ? 'danger' : 'safe'}">${weeklyRemainingPercent}% remaining</span>
            </div>
            <div class="progress-container">
                <div class="progress-fill" style="width: ${weeklyUsedPercent}%;"></div>
            </div>
            <div class="card-stats">
                <span>Used: <strong>${group.weeklyTokensUsed.toLocaleString()}</strong></span>
                <span>Left: <strong>${weeklyRemaining.toLocaleString()}</strong></span>
            </div>
        </div>
    </div>`;
        }

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
    
    ${groupsHtml}

    <div class="info-text">
        * Data is fetched locally for least impact. Uses ~/.gemini/antigravity-usage.json.
    </div>
</body>
</html>`;
    }
}
