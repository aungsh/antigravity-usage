/**
 * Adapted from https://github.com/Henrik-3/AntigravityQuota (MIT License)
 * 
 * Process detector for Antigravity Language Server.
 * Finds running instances, extracts CSRF tokens, and discovers listening ports.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import * as process from 'process';
import { ConnectionInfo } from '../types';

const execAsync = promisify(exec);

interface PlatformStrategy {
    getProcessListCommand(processName: string): string;
    parseProcessInfo(stdout: string): { pid: number; extensionPort: number; csrfToken: string } | null;
    getPortListCommand(pid: number): string;
    parseListeningPorts(stdout: string, pid: number): number[];
}

class WindowsStrategy implements PlatformStrategy {
    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();
        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) return true;
        if (lowerCmd.includes('\\antigravity\\') || lowerCmd.includes('/antigravity/')) return true;
        return false;
    }

    getProcessListCommand(processName: string): string {
        return `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${processName}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
    }

    parseProcessInfo(stdout: string): { pid: number; extensionPort: number; csrfToken: string } | null {
        try {
            let data = JSON.parse(stdout.trim());
            if (Array.isArray(data)) {
                if (data.length === 0) return null;
                const agProcesses = data.filter((item: any) => item.CommandLine && this.isAntigravityProcess(item.CommandLine));
                if (agProcesses.length === 0) return null;
                data = agProcesses[0];
            } else {
                if (!data.CommandLine || !this.isAntigravityProcess(data.CommandLine)) return null;
            }

            const commandLine = data.CommandLine || '';
            const pid = data.ProcessId;
            if (!pid) return null;

            const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);

            if (!tokenMatch || !tokenMatch[1]) return null;

            return {
                pid,
                extensionPort: portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0,
                csrfToken: tokenMatch[1]
            };
        } catch (e) {
            // Fallback to wmic-style parsing if powershell JSON failed
            const blocks = stdout.split(/\n\s*\n/).filter(block => block.trim().length > 0);
            for (const block of blocks) {
                const pidMatch = block.match(/ProcessId=(\d+)/);
                const cmdMatch = block.match(/CommandLine=(.+)/);
                if (!pidMatch || !cmdMatch) continue;
                const commandLine = cmdMatch[1].trim();
                if (!this.isAntigravityProcess(commandLine)) continue;

                const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
                const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
                if (!tokenMatch || !tokenMatch[1]) continue;

                return {
                    pid: parseInt(pidMatch[1], 10),
                    extensionPort: portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0,
                    csrfToken: tokenMatch[1]
                };
            }
            return null;
        }
    }

    getPortListCommand(pid: number): string {
        return `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json"`;
    }

    parseListeningPorts(stdout: string, pid: number): number[] {
        const ports: number[] = [];
        try {
            const data = JSON.parse(stdout.trim());
            if (Array.isArray(data)) {
                for (const port of data) {
                    if (typeof port === 'number' && !ports.includes(port)) {
                        ports.push(port);
                    }
                }
            } else if (typeof data === 'number') {
                ports.push(data);
            }
        } catch {
            const portRegex = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]):(\\d+)\\s+(?:0\\.0\\.0\\.0:0|\\[::\\]:0|\\*:\\*).*?\\s+${pid}$`, 'gim');
            let match;
            while ((match = portRegex.exec(stdout)) !== null) {
                const port = parseInt(match[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            }
        }
        return ports.sort((a, b) => a - b);
    }
}

class UnixStrategy implements PlatformStrategy {
    private platform: string;
    constructor(platform: string) {
        this.platform = platform;
    }

    getProcessListCommand(processName: string): string {
        if (this.platform === 'darwin') {
            return `LC_ALL=C pgrep -fl ${processName}`;
        }
        return `LC_ALL=C pgrep -af ${processName}`;
    }

    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();
        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) return true;
        if (lowerCmd.includes('\\antigravity\\') || lowerCmd.includes('/antigravity/')) return true;
        return false;
    }

    parseProcessInfo(stdout: string): { pid: number; extensionPort: number; csrfToken: string } | null {
        const lines = stdout.split('\n').filter(line => line.trim().length > 0);
        for (const line of lines) {
            if (!line.includes('--extension_server_port')) continue;

            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[0], 10);
            const cmd = line.substring(parts[0].length).trim();

            if (!this.isAntigravityProcess(cmd)) continue;

            const portMatch = cmd.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);

            if (!tokenMatch?.[1]) continue;

            return {
                pid,
                extensionPort: portMatch ? parseInt(portMatch[1], 10) : 0,
                csrfToken: tokenMatch[1]
            };
        }
        return null;
    }

    getPortListCommand(pid: number): string {
        if (this.platform === 'darwin') {
            return `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`;
        }
        return `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;
    }

    parseListeningPorts(stdout: string, pid: number): number[] {
        const ports: number[] = [];
        const lsofRegex = new RegExp(`^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`, 'gim');

        if (this.platform === 'darwin') {
            let match;
            while ((match = lsofRegex.exec(stdout)) !== null) {
                const port = parseInt(match[1], 10);
                if (!ports.includes(port)) ports.push(port);
            }
        } else {
            const ssRegex = new RegExp(`LISTEN\\s+\\d+\\s+\\d+\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]*\\]):(\\d+).*?users:.*?,pid=${pid},`, 'gi');
            let match;
            while ((match = ssRegex.exec(stdout)) !== null) {
                const port = parseInt(match[1], 10);
                if (!ports.includes(port)) ports.push(port);
            }
            if (ports.length === 0) {
                while ((match = lsofRegex.exec(stdout)) !== null) {
                    const port = parseInt(match[1], 10);
                    if (!ports.includes(port)) ports.push(port);
                }
            }
        }
        return ports.sort((a, b) => a - b);
    }
}

export class ProcessDetector {
    private cachedConnection: ConnectionInfo | null = null;
    private cacheExpiry = 0;
    private readonly CACHE_TTL_MS = 30_000;
    
    private strategy: PlatformStrategy;
    private processName: string;

    constructor() {
        if (process.platform === 'win32') {
            this.strategy = new WindowsStrategy();
            this.processName = `language_server_windows_${process.arch === 'arm64' ? 'arm' : 'x64'}.exe`;
        } else if (process.platform === 'darwin') {
            this.strategy = new UnixStrategy('darwin');
            this.processName = `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`;
        } else {
            this.strategy = new UnixStrategy('linux');
            this.processName = `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`;
        }
    }

    invalidateCache(): void {
        this.cachedConnection = null;
        this.cacheExpiry = 0;
    }

    async detect(maxRetries: number = 1): Promise<ConnectionInfo | null> {
        if (this.cachedConnection && Date.now() < this.cacheExpiry) {
            return this.cachedConnection;
        }

        for (let i = 0; i < maxRetries; i++) {
            try {
                const cmd = this.strategy.getProcessListCommand(this.processName);
                const { stdout } = await execAsync(cmd);
                const info = this.strategy.parseProcessInfo(stdout);

                if (info) {
                    const ports = await this.getListeningPorts(info.pid);
                    if (ports.length > 0) {
                        const validPort = await this.findWorkingPort(ports, info.csrfToken);
                        if (validPort) {
                            const connection: ConnectionInfo = {
                                pid: info.pid,
                                port: validPort,
                                authToken: info.csrfToken,
                                isHttps: true // Based on the testPort method returning true on https request
                            };
                            this.cachedConnection = connection;
                            this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;
                            return connection;
                        }
                    }
                }
            } catch (e) {
                // Ignore and retry
            }

            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 100));
            }
        }

        this.cachedConnection = null;
        return null;
    }

    private async getListeningPorts(pid: number): Promise<number[]> {
        try {
            const cmd = this.strategy.getPortListCommand(pid);
            const { stdout } = await execAsync(cmd);
            return this.strategy.parseListeningPorts(stdout, pid);
        } catch {
            return [];
        }
    }

    private async findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
        for (const port of ports) {
            const isWorking = await this.testPort(port, csrfToken);
            if (isWorking) {
                return port;
            }
        }
        return null;
    }

    private testPort(port: number, csrfToken: string): Promise<boolean> {
        return new Promise(resolve => {
            const options = {
                hostname: '127.0.0.1',
                port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': csrfToken,
                    'Connect-Protocol-Version': '1',
                },
                rejectUnauthorized: false,
                timeout: 5000,
            };

            const req = https.request(options, res => {
                let body = '';
                res.on('data', chunk => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            JSON.parse(body);
                            resolve(true);
                        } catch {
                            resolve(false);
                        }
                    } else {
                        resolve(false);
                    }
                });
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.write(JSON.stringify({ wrapper_data: {} }));
            req.end();
        });
    }
}
