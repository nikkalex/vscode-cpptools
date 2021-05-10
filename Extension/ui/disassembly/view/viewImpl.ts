/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Origina file: vscode/src/vs/editor/browser/view/viewImpl.ts

import * as dom from '../dom';
import * as browser from '../browser';
import { Selection } from '../core/selection';
import { FastDomNode, createFastDomNode } from '../fastDomNode';
import { IMouseEvent } from '../mouseEvent';
import { onUnexpectedError } from '../errors';
import { IDisposable } from '../lifecycle';
import { MouseHandler, IPointerHandlerHelper } from '../controller/mouseHandler';
import { ITextAreaHandlerHelper, TextAreaHandler } from '../controller/textAreaHandler';
import { IContentWidget, IContentWidgetPosition, IOverlayWidget, IOverlayWidgetPosition, IMouseTarget, IViewZoneChangeAccessor, IEditorAriaOptions } from '../editorBrowser';
import { ViewController } from '../view/viewController';
import { ViewUserInputEvents } from '../view/viewUserInputEvents';
import { ContentViewOverlays, MarginViewOverlays } from '../view/viewOverlays';
import { PartFingerprint, PartFingerprints, ViewPart } from '../view/viewPart';
import { ViewContentWidgets } from '../viewParts/contentWidgets/contentWidgets';
import { DecorationsOverlay } from '../viewParts/decorations/decorations';
import { EditorScrollbar } from '../viewParts/editorScrollbar/editorScrollbar';
import { GlyphMarginOverlay } from '../viewParts/glyphMargin/glyphMargin';
import { LineNumbersOverlay } from '../viewParts/lineNumbers/lineNumbers';
import { ViewLines } from '../viewParts/lines/viewLines';
import { LinesDecorationsOverlay } from '../viewParts/linesDecorations/linesDecorations';
import { Margin } from '../viewParts/margin/margin';
import { MarginViewLineDecorationsOverlay } from '../viewParts/marginDecorations/marginDecorations';
import { ViewOverlayWidgets } from '../viewParts/overlayWidgets/overlayWidgets';
import { ScrollDecorationViewPart } from '../viewParts/scrollDecoration/scrollDecoration';
import { SelectionsOverlay } from '../viewParts/selections/selections';
import { ViewCursors } from '../viewParts/viewCursors/viewCursors';
import { ViewZones } from '../viewParts/viewZones/viewZones';
import { Position } from '../core/position';
import { Range } from '../core/range';
import { IConfiguration, ScrollType } from '../editorCommon';
import { RenderingContext } from '../view/renderingContext';
import { ViewContext } from '../view/viewContext';
import * as viewEvents from '../view/viewEvents';
import { ViewportData } from '../viewLayout/viewLinesViewportData';
import { ViewEventHandler } from '../viewModel/viewEventHandler';
import { IViewModel } from '../viewModel/viewModel';
import { EditorOption } from '../config/editorOptions';
import { PointerHandlerLastRenderData } from '../controller/mouseTarget';


export interface IContentWidgetData {
	widget: IContentWidget;
	position: IContentWidgetPosition | null;
}

export interface IOverlayWidgetData {
	widget: IOverlayWidget;
	position: IOverlayWidgetPosition | null;
}

export class View extends ViewEventHandler {

	private readonly _scrollbar: EditorScrollbar;
	private readonly _context: ViewContext;
	private _configPixelRatio: number;
	private _selections: Selection[];

	// The view lines
	private readonly _viewLines: ViewLines;

	// These are parts, but we must do some API related calls on them, so we keep a reference
	private readonly _viewZones: ViewZones;
	private readonly _contentWidgets: ViewContentWidgets;
	private readonly _overlayWidgets: ViewOverlayWidgets;
	private readonly _viewCursors: ViewCursors;
	private readonly _viewParts: ViewPart[];

	private readonly _textAreaHandler: TextAreaHandler;
	private readonly _pointerHandler: MouseHandler;

	// Dom nodes
	private readonly _linesContent: FastDomNode<HTMLElement>;
	public readonly domNode: FastDomNode<HTMLElement>;
	private readonly _overflowGuardContainer: FastDomNode<HTMLElement>;

	// Actual mutable state
	private _renderAnimationFrame: IDisposable | null;

	constructor(
		configuration: IConfiguration,
		model: IViewModel,
		userInputEvents: ViewUserInputEvents,
		overflowWidgetsDomNode: HTMLElement | undefined
	) {
		super();
		this._selections = [new Selection(1, 1, 1, 1)];
		this._renderAnimationFrame = null;

		const viewController = new ViewController(configuration, model, userInputEvents);

		// The view context is passed on to most classes (basically to reduce param. counts in ctors)
		this._context = new ViewContext(configuration, model);
		this._configPixelRatio = this._context.configuration.options.get(EditorOption.pixelRatio);

		// Ensure the view is the first event handler in order to update the layout
		this._context.addEventHandler(this);

		this._viewParts = [];

		// Keyboard handler
		this._textAreaHandler = new TextAreaHandler(this._context, viewController, this._createTextAreaHandlerHelper());
		this._viewParts.push(this._textAreaHandler);

		// These two dom nodes must be constructed up front, since references are needed in the layout provider (scrolling & co.)
		this._linesContent = createFastDomNode(document.createElement('div'));
		this._linesContent.setClassName('lines-content' + ' monaco-editor-background');
		this._linesContent.setPosition('absolute');

		this.domNode = createFastDomNode(document.createElement('div'));
		this.domNode.setClassName(this._getEditorClassName());
		// Set role 'code' for better screen reader support https://github.com/microsoft/vscode/issues/93438
		this.domNode.setAttribute('role', 'code');

		this._overflowGuardContainer = createFastDomNode(document.createElement('div'));
		PartFingerprints.write(this._overflowGuardContainer, PartFingerprint.OverflowGuard);
		this._overflowGuardContainer.setClassName('overflow-guard');

		this._scrollbar = new EditorScrollbar(this._context, this._linesContent, this.domNode, this._overflowGuardContainer);
		this._viewParts.push(this._scrollbar);

		// View Lines
		this._viewLines = new ViewLines(this._context, this._linesContent);

		// View Zones
		this._viewZones = new ViewZones(this._context);
		this._viewParts.push(this._viewZones);


		const scrollDecoration = new ScrollDecorationViewPart(this._context);
		this._viewParts.push(scrollDecoration);

		const contentViewOverlays = new ContentViewOverlays(this._context);
		this._viewParts.push(contentViewOverlays);
		contentViewOverlays.addDynamicOverlay(new SelectionsOverlay(this._context));
		contentViewOverlays.addDynamicOverlay(new DecorationsOverlay(this._context));

		const marginViewOverlays = new MarginViewOverlays(this._context);
		this._viewParts.push(marginViewOverlays);
		marginViewOverlays.addDynamicOverlay(new GlyphMarginOverlay(this._context));
		marginViewOverlays.addDynamicOverlay(new MarginViewLineDecorationsOverlay(this._context));
		marginViewOverlays.addDynamicOverlay(new LinesDecorationsOverlay(this._context));
		marginViewOverlays.addDynamicOverlay(new LineNumbersOverlay(this._context));

		const margin = new Margin(this._context);
		margin.getDomNode().appendChild(this._viewZones.marginDomNode);
		margin.getDomNode().appendChild(marginViewOverlays.getDomNode());
		this._viewParts.push(margin);

		// Content widgets
		this._contentWidgets = new ViewContentWidgets(this._context, this.domNode);
		this._viewParts.push(this._contentWidgets);

		this._viewCursors = new ViewCursors(this._context);
		this._viewParts.push(this._viewCursors);

		// Overlay widgets
		this._overlayWidgets = new ViewOverlayWidgets(this._context);
		this._viewParts.push(this._overlayWidgets);

		// -------------- Wire dom nodes up

		this._linesContent.appendChild(contentViewOverlays.getDomNode());
		this._linesContent.appendChild(this._viewZones.domNode);
		this._linesContent.appendChild(this._viewLines.getDomNode());
		this._linesContent.appendChild(this._contentWidgets.domNode);
		this._linesContent.appendChild(this._viewCursors.getDomNode());
		this._overflowGuardContainer.appendChild(margin.getDomNode());
		this._overflowGuardContainer.appendChild(this._scrollbar.getDomNode());
		this._overflowGuardContainer.appendChild(scrollDecoration.getDomNode());
		this._overflowGuardContainer.appendChild(this._textAreaHandler.textArea);
		this._overflowGuardContainer.appendChild(this._textAreaHandler.textAreaCover);
		this._overflowGuardContainer.appendChild(this._overlayWidgets.getDomNode());
		this.domNode.appendChild(this._overflowGuardContainer);

		if (overflowWidgetsDomNode) {
			overflowWidgetsDomNode.appendChild(this._contentWidgets.overflowingContentWidgetsDomNode.domNode);
		} else {
			this.domNode.appendChild(this._contentWidgets.overflowingContentWidgetsDomNode);
		}

		this._applyLayout();

		// Pointer handler
		this._pointerHandler = this._register(new MouseHandler(this._context, viewController, this._createPointerHandlerHelper()));
	}

	private _flushAccumulatedAndRenderNow(): void {
		this._renderNow();
	}

	private _createPointerHandlerHelper(): IPointerHandlerHelper {
		return {
			viewDomNode: this.domNode.domNode,
			linesContentDomNode: this._linesContent.domNode,

			focusTextArea: () => {
				this.focus();
			},

			dispatchTextAreaEvent: (event: CustomEvent) => {
				this._textAreaHandler.textArea.domNode.dispatchEvent(event);
			},

			getLastRenderData: (): PointerHandlerLastRenderData => {
				const lastViewCursorsRenderData = this._viewCursors.getLastRenderData() || [];
				const lastTextareaPosition = this._textAreaHandler.getLastRenderData();
				return new PointerHandlerLastRenderData(lastViewCursorsRenderData, lastTextareaPosition);
			},
			shouldSuppressMouseDownOnViewZone: (viewZoneId: string) => {
				return this._viewZones.shouldSuppressMouseDownOnViewZone(viewZoneId);
			},
			shouldSuppressMouseDownOnWidget: (widgetId: string) => {
				return this._contentWidgets.shouldSuppressMouseDownOnWidget(widgetId);
			},
			getPositionFromDOMInfo: (spanNode: HTMLElement, offset: number) => {
				this._flushAccumulatedAndRenderNow();
				return this._viewLines.getPositionFromDOMInfo(spanNode, offset);
			},

			visibleRangeForPosition: (lineNumber: number, column: number) => {
				this._flushAccumulatedAndRenderNow();
				return this._viewLines.visibleRangeForPosition(new Position(lineNumber, column));
			},

			getLineWidth: (lineNumber: number) => {
				this._flushAccumulatedAndRenderNow();
				return this._viewLines.getLineWidth(lineNumber);
			}
		};
	}

	private _createTextAreaHandlerHelper(): ITextAreaHandlerHelper {
		return {
			visibleRangeForPositionRelativeToEditor: (lineNumber: number, column: number) => {
				this._flushAccumulatedAndRenderNow();
				return this._viewLines.visibleRangeForPosition(new Position(lineNumber, column));
			}
		};
	}

	private _applyLayout(): void {
		const options = this._context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);

		this.domNode.setWidth(layoutInfo.width);
		this.domNode.setHeight(layoutInfo.height);

		this._overflowGuardContainer.setWidth(layoutInfo.width);
		this._overflowGuardContainer.setHeight(layoutInfo.height);

		this._linesContent.setWidth(1000000);
		this._linesContent.setHeight(1000000);
	}

	private _getEditorClassName() {
		const focused = this._textAreaHandler.isFocused() ? ' focused' : '';
		return this._context.configuration.options.get(EditorOption.editorClassName) + focused;
	}

	// --- begin event handlers
	public override handleEvents(events: viewEvents.ViewEvent[]): void {
		super.handleEvents(events);
		this._scheduleRender();
	}
	public override onConfigurationChanged(e: viewEvents.ViewConfigurationChangedEvent): boolean {
		this._configPixelRatio = this._context.configuration.options.get(EditorOption.pixelRatio);
		this.domNode.setClassName(this._getEditorClassName());
		this._applyLayout();
		return false;
	}
	public override onCursorStateChanged(e: viewEvents.ViewCursorStateChangedEvent): boolean {
		this._selections = e.selections;
		return false;
	}
	public override onFocusChanged(e: viewEvents.ViewFocusChangedEvent): boolean {
		this.domNode.setClassName(this._getEditorClassName());
		return false;
	}
	public override onThemeChanged(e: viewEvents.ViewThemeChangedEvent): boolean {
		this.domNode.setClassName(this._getEditorClassName());
		return false;
	}

	// --- end event handlers

	public override dispose(): void {
		if (this._renderAnimationFrame !== null) {
			this._renderAnimationFrame.dispose();
			this._renderAnimationFrame = null;
		}

		this._contentWidgets.overflowingContentWidgetsDomNode.domNode.remove();

		this._context.removeEventHandler(this);

		this._viewLines.dispose();

		// Destroy view parts
		for (const viewPart of this._viewParts) {
			viewPart.dispose();
		}

		super.dispose();
	}

	private _scheduleRender(): void {
		if (this._renderAnimationFrame === null) {
			this._renderAnimationFrame = dom.runAtThisOrScheduleAtNextAnimationFrame(this._onRenderScheduled.bind(this), 100);
		}
	}

	private _onRenderScheduled(): void {
		this._renderAnimationFrame = null;
		this._flushAccumulatedAndRenderNow();
	}

	private _renderNow(): void {
		safeInvokeNoArg(() => this._actualRender());
	}

	private _getViewPartsToRender(): ViewPart[] {
		let result: ViewPart[] = [], resultLen = 0;
		for (const viewPart of this._viewParts) {
			if (viewPart.shouldRender()) {
				result[resultLen++] = viewPart;
			}
		}
		return result;
	}

	private _actualRender(): void {
		if (!dom.isInDOM(this.domNode.domNode)) {
			return;
		}

		let viewPartsToRender = this._getViewPartsToRender();

		if (!this._viewLines.shouldRender() && viewPartsToRender.length === 0) {
			// Nothing to render
			return;
		}

		const partialViewportData = this._context.viewLayout.getLinesViewportData();
		this._context.model.setViewport(partialViewportData.startLineNumber, partialViewportData.endLineNumber, partialViewportData.centeredLineNumber);

		const viewportData = new ViewportData(
			this._selections,
			partialViewportData,
			this._context.viewLayout.getWhitespaceViewportData(),
			this._context.model
		);

		if (this._contentWidgets.shouldRender()) {
			// Give the content widgets a chance to set their max width before a possible synchronous layout
			this._contentWidgets.onBeforeRender(viewportData);
		}

		if (this._viewLines.shouldRender()) {
			this._viewLines.renderText(viewportData);
			this._viewLines.onDidRender();

			// Rendering of viewLines might cause scroll events to occur, so collect view parts to render again
			viewPartsToRender = this._getViewPartsToRender();
		}

		const renderingContext = new RenderingContext(this._context.viewLayout, viewportData, this._viewLines);

		// Render the rest of the parts
		for (const viewPart of viewPartsToRender) {
			viewPart.prepareRender(renderingContext);
		}

		for (const viewPart of viewPartsToRender) {
			viewPart.render(renderingContext);
			viewPart.onDidRender();
		}

		// Try to detect browser zooming and paint again if necessary
		if (Math.abs(browser.getPixelRatio() - this._configPixelRatio) > 0.001) {
			// looks like the pixel ratio has changed
			this._context.configuration.updatePixelRatio();
		}
	}

	// --- BEGIN CodeEditor helpers

	public delegateVerticalScrollbarMouseDown(browserEvent: IMouseEvent): void {
		this._scrollbar.delegateVerticalScrollbarMouseDown(browserEvent);
	}

	public restoreState(scrollPosition: { scrollLeft: number; scrollTop: number; }): void {
		this._context.model.setScrollPosition({ scrollTop: scrollPosition.scrollTop }, ScrollType.Immediate);
		this._renderNow();
		this._viewLines.updateLineWidths();
		this._context.model.setScrollPosition({ scrollLeft: scrollPosition.scrollLeft }, ScrollType.Immediate);
	}

	public getOffsetForColumn(modelLineNumber: number, modelColumn: number): number {
		const modelPosition = this._context.model.validateModelPosition({
			lineNumber: modelLineNumber,
			column: modelColumn
		});
		const viewPosition = this._context.model.coordinatesConverter.convertModelPositionToViewPosition(modelPosition);
		this._flushAccumulatedAndRenderNow();
		const visibleRange = this._viewLines.visibleRangeForPosition(new Position(viewPosition.lineNumber, viewPosition.column));
		if (!visibleRange) {
			return -1;
		}
		return visibleRange.left;
	}

	public getTargetAtClientPoint(clientX: number, clientY: number): IMouseTarget | null {
		const mouseTarget = this._pointerHandler.getTargetAtClientPoint(clientX, clientY);
		if (!mouseTarget) {
			return null;
		}
		return ViewUserInputEvents.convertViewToModelMouseTarget(mouseTarget, this._context.model.coordinatesConverter);
	}

	public change(callback: (changeAccessor: IViewZoneChangeAccessor) => any): void {
		this._viewZones.changeViewZones(callback);
		this._scheduleRender();
	}

	public render(now: boolean, everything: boolean): void {
		if (everything) {
			// Force everything to render...
			this._viewLines.forceShouldRender();
			for (const viewPart of this._viewParts) {
				viewPart.forceShouldRender();
			}
		}
		if (now) {
			this._flushAccumulatedAndRenderNow();
		} else {
			this._scheduleRender();
		}
	}

	public focus(): void {
		this._textAreaHandler.focusTextArea();
	}

	public isFocused(): boolean {
		return this._textAreaHandler.isFocused();
	}

	public refreshFocusState() {
		this._textAreaHandler.refreshFocusState();
	}

	public setAriaOptions(options: IEditorAriaOptions): void {
		this._textAreaHandler.setAriaOptions(options);
	}

	public addContentWidget(widgetData: IContentWidgetData): void {
		this._contentWidgets.addWidget(widgetData.widget);
		this.layoutContentWidget(widgetData);
		this._scheduleRender();
	}

	public layoutContentWidget(widgetData: IContentWidgetData): void {
		let newRange = widgetData.position ? widgetData.position.range || null : null;
		if (newRange === null) {
			const newPosition = widgetData.position ? widgetData.position.position : null;
			if (newPosition !== null) {
				newRange = new Range(newPosition.lineNumber, newPosition.column, newPosition.lineNumber, newPosition.column);
			}
		}
		const newPreference = widgetData.position ? widgetData.position.preference : null;
		this._contentWidgets.setWidgetPosition(widgetData.widget, newRange, newPreference);
		this._scheduleRender();
	}

	public removeContentWidget(widgetData: IContentWidgetData): void {
		this._contentWidgets.removeWidget(widgetData.widget);
		this._scheduleRender();
	}

	public addOverlayWidget(widgetData: IOverlayWidgetData): void {
		this._overlayWidgets.addWidget(widgetData.widget);
		this.layoutOverlayWidget(widgetData);
		this._scheduleRender();
	}

	public layoutOverlayWidget(widgetData: IOverlayWidgetData): void {
		const newPreference = widgetData.position ? widgetData.position.preference : null;
		const shouldRender = this._overlayWidgets.setWidgetPosition(widgetData.widget, newPreference);
		if (shouldRender) {
			this._scheduleRender();
		}
	}

	public removeOverlayWidget(widgetData: IOverlayWidgetData): void {
		this._overlayWidgets.removeWidget(widgetData.widget);
		this._scheduleRender();
	}

	// --- END CodeEditor helpers

}

function safeInvokeNoArg(func: Function): any {
	try {
		return func();
	} catch (e) {
		onUnexpectedError(e);
	}
}
