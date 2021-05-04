/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import { DebugProtocol } from 'vscode-debugProtocol';

interface VsCodeApi {
    postMessage(msg: {}): void;
    setState(state: {}): void;
    getState(): {};
}

declare function acquireVsCodeApi(): VsCodeApi;

class DisassemblyApp {
    private readonly vsCodeApi: VsCodeApi;

    constructor() {
        this.vsCodeApi = acquireVsCodeApi();

        // Handle the message inside the webview
        window.addEventListener('message', event => {
            const message = event.data; // The JSON data our extension sent
            switch (message.command) {
                case 'insertAssembly': {
                    const instructions: DebugProtocol.DisassembledInstruction[] = message.instructions;
                    instructions.forEach(instruction => {
                        const div = document.createElement('div');
                        if (instruction.instructionBytes) {
                            div.innerText = `${instruction.address}\t${instruction.instructionBytes}\t${instruction.instruction}`;
                        } else {
                            div.innerText = `${instruction.address}\t${instruction.instruction}`;
                        }
                        document.body.appendChild(div);
                    });
                    break;
                }
            }
        });

        const testButton = document.getElementById('test');
        testButton?.addEventListener('click', () => { this.vsCodeApi.postMessage({ command: 'loadAssembly' }); })
    }
}

// @ts-ignore: TS6133: 'disassemblyApp' is declared but its value is never read.
const disassemblyApp: DisassemblyApp = new DisassemblyApp();
