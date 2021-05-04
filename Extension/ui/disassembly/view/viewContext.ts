/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Original file: vscode/src/vs/editor/common/view/viewContext.ts

import { IConfiguration } from '../editorCommon';
import { ViewEventHandler } from '../viewModel/viewEventHandler';
import { IViewLayout, IViewModel } from '../viewModel/viewModel';

export class ViewContext {

	public readonly configuration: IConfiguration;
	public readonly model: IViewModel;
	public readonly viewLayout: IViewLayout;

	constructor(
		configuration: IConfiguration,
		model: IViewModel
	) {
		this.configuration = configuration;
		this.model = model;
		this.viewLayout = model.viewLayout;
	}

	public addEventHandler(eventHandler: ViewEventHandler): void {
		this.model.addViewEventHandler(eventHandler);
	}

	public removeEventHandler(eventHandler: ViewEventHandler): void {
		this.model.removeViewEventHandler(eventHandler);
	}
}
