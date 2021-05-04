/*! -------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import * as vscode from 'vscode';
import { CppdbgTrackerAdapterDescriptionFactor } from './debugAdapterDescriptorFactory';
import * as util from '../common';
import * as fs from 'fs';

export class DisassemblyPage {
    private static _panel?: vscode.WebviewPanel;

    private static readonly _panelDisposables: vscode.Disposable[] = [];

    public static createOrShow(debugTracker: CppdbgTrackerAdapterDescriptionFactor): void {
        if (this._panel) {
            this._panel.reveal();
            return;
        }

        this._panel = vscode.window.createWebviewPanel('disassemblyPage', 'Disassembly', vscode.ViewColumn.One,
            {
                enableScripts: true,
                enableCommandUris: true,
                localResourceRoots: [
                    vscode.Uri.file(util.extensionPath),
                    vscode.Uri.file(path.join(util.extensionPath, 'ui')),
                    vscode.Uri.file(path.join(util.extensionPath, 'out', 'ui'))
                ]
            }
        );

        this._panel.webview.html = this.getHtml();

        this._panelDisposables.push(this._panel.onDidDispose(() => this.disposePanel()));
        this._panelDisposables.push(this._panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'loadAssembly') {
                debugTracker.getActiveDebugAdapterTracker()?.sendDisassemblyRequestByFrame(0, 0, 0, 10).then(response => {
                    // const instructions: debugProtocol.DebugProtocol.DisassembledInstruction[] = response.instructions;
                    // let msg = '';
                    // instructions.forEach(instr => msg += `${instr.address} | ${instr.instructionBytes} | ${instr.instruction} | ${instr.line} | ${instr.location}<br>`)
                    this._panel!.webview.postMessage({command:"insertAssembly", instructions: response.instructions});
                });
            }
        }));
        debugTracker.getActiveDebugAdapterTracker()?.sendDisassemblyRequestByFrame(0, 0, 0, 10).then(response => {
            this._panel!.webview.postMessage({command:"insertAssembly", instructions: response.instructions});
        });
    }

    private static getHtml(): string {
        let content = fs.readFileSync(util.getLocalizedHtmlPath("ui/disassembly/disassembly.html")).toString();

        if (this._panel && this._panel.webview) {
            const settingsJsUri: vscode.Uri = this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(util.extensionPath, 'dist/disassembly.js')));
            content = content.replace(/{{disassembly_js_uri}}/g, settingsJsUri.toString());
        }

        content = content.replace(/{{nonce}}/g, util.getNonce());

        return content;
    }

    public static disposePanel(): void {
        while (this._panelDisposables.length) {
            const x = this._panelDisposables.pop();
            if (x) {
                x.dispose();
            }
        }
        this._panel = undefined;
    }
}