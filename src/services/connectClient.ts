/**
 * Adapted from https://github.com/Henrik-3/AntigravityQuota (MIT License)
 * 
 * Connect RPC client for the Antigravity Language Server.
 * Fetches real-time quota/usage data via the local Connect API.
 */

import * as https from 'https';
import { ServerUserStatusResponse } from '../types';

export class ConnectClient {
    /**
     * Fetch user status (quota data) from the local Language Server.
     */
    async getUserStatus(
        baseUrl: string,
        csrfToken: string
    ): Promise<ServerUserStatusResponse> {
        const endpoint = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
        const body = JSON.stringify({
            metadata: {
                ideName: 'antigravity',
                extensionName: 'antigravity',
                locale: 'en',
            },
        });
        return this.request<ServerUserStatusResponse>(baseUrl, endpoint, body, csrfToken);
    }

    private request<T>(
        baseUrl: string,
        path: string,
        body: string,
        csrfToken: string,
        timeout = 5000
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const url = new URL(path, baseUrl);
            
            // Safety check for localhost
            if (!url.hostname.match(/^(127\.0\.0\.1|localhost|::1)$/)) {
                reject(new Error('Refusing non-localhost connection'));
                return;
            }

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(body)),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken
            };

            const options = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers,
                timeout,
                rejectUnauthorized: false,
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data) as T);
                    } catch {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });

            req.on('error', (err) => reject(err));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });

            req.write(body);
            req.end();
        });
    }
}
