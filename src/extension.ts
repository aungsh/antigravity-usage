import * as vscode from 'vscode';
import { AntigravityUsageProvider } from './usageViewProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new AntigravityUsageProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AntigravityUsageProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityUsage.refresh', () => {
            provider.refresh();
        })
    );
}

export function deactivate() {}
