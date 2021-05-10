/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Original file: vscode/src/vs/editor/common/editorCommon.ts

import { IDisposable } from './lifecycle';
import { Event } from './event';
import { UriComponents } from './uri';
import { ConfigurationChangedEvent, IComputedEditorOptions, IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { IPosition, Position } from './core/position';
import { IRange, Range } from './core/range';
import { ISelection, Selection } from './core/selection';
import { IModelDecorationsChangeAccessor, ITextModel, TrackedRangeStickiness } from './model';

export interface IDimension {
	width: number;
	height: number;
}

/**
 * A change
 */
export interface IChange {
	readonly originalStartLineNumber: number;
	readonly originalEndLineNumber: number;
	readonly modifiedStartLineNumber: number;
	readonly modifiedEndLineNumber: number;
}

/**
 * @internal
 */
export interface IConfiguration extends IDisposable {
	onDidChangeFast(listener: (e: ConfigurationChangedEvent) => void): IDisposable;
	onDidChange(listener: (e: ConfigurationChangedEvent) => void): IDisposable;

	readonly options: IComputedEditorOptions;

	setMaxLineNumber(maxLineNumber: number): void;
	setViewLineCount(viewLineCount: number): void;
	updateOptions(newOptions: Readonly<IEditorOptions>): void;
	getRawOptions(): IEditorOptions;
	observeReferenceElement(dimension?: IDimension): void;
	updatePixelRatio(): void;
	setIsDominatedByLongLines(isDominatedByLongLines: boolean): void;
}

// --- view

export interface IScrollEvent {
	readonly scrollTop: number;
	readonly scrollLeft: number;
	readonly scrollWidth: number;
	readonly scrollHeight: number;

	readonly scrollTopChanged: boolean;
	readonly scrollLeftChanged: boolean;
	readonly scrollWidthChanged: boolean;
	readonly scrollHeightChanged: boolean;
}

export interface IContentSizeChangedEvent {
	readonly contentWidth: number;
	readonly contentHeight: number;

	readonly contentWidthChanged: boolean;
	readonly contentHeightChanged: boolean;
}

export interface INewScrollPosition {
	scrollLeft?: number;
	scrollTop?: number;
}

export interface IEditorAction {
	readonly id: string;
	readonly label: string;
	readonly alias: string;
	isSupported(): boolean;
	run(): Promise<void>;
}

export type IEditorModel = ITextModel;

/**
 * A (serializable) state of the cursors.
 */
export interface ICursorState {
	inSelectionMode: boolean;
	selectionStart: IPosition;
	position: IPosition;
}
/**
 * A (serializable) state of the view.
 */
export interface IViewState {
	/** written by previous versions */
	scrollTop?: number;
	/** written by previous versions */
	scrollTopWithoutViewZones?: number;
	scrollLeft: number;
	firstPosition: IPosition;
	firstPositionDeltaTop: number;
}
/**
 * A (serializable) state of the code editor.
 */
export interface ICodeEditorViewState {
	cursorState: ICursorState[];
	viewState: IViewState;
	contributionsState: { [id: string]: any };
}
/**
 * (Serializable) View state for the diff editor.
 */
export interface IDiffEditorViewState {
	original: ICodeEditorViewState | null;
	modified: ICodeEditorViewState | null;
}
/**
 * An editor view state.
 */
export type IEditorViewState = ICodeEditorViewState | IDiffEditorViewState;

export const enum ScrollType {
	Smooth = 0,
	Immediate = 1,
}

/**
 * An editor.
 */
export interface IEditor {
	/**
	 * An event emitted when the editor has been disposed.
	 * @event
	 */
	onDidDispose(listener: () => void): IDisposable;

	/**
	 * Dispose the editor.
	 */
	dispose(): void;

	/**
	 * Get a unique id for this editor instance.
	 */
	getId(): string;

	/**
	 * Get the editor type. Please see `EditorType`.
	 * This is to avoid an instanceof check
	 */
	getEditorType(): string;

	/**
	 * Update the editor's options after the editor has been created.
	 */
	updateOptions(newOptions: IEditorOptions): void;

	/**
	 * Indicates that the editor becomes visible.
	 * @internal
	 */
	onVisible(): void;

	/**
	 * Indicates that the editor becomes hidden.
	 * @internal
	 */
	onHide(): void;

	/**
	 * Instructs the editor to remeasure its container. This method should
	 * be called when the container of the editor gets resized.
	 *
	 * If a dimension is passed in, the passed in value will be used.
	 */
	layout(dimension?: IDimension): void;

	/**
	 * Brings browser focus to the editor text
	 */
	focus(): void;

	/**
	 * Returns true if the text inside this editor is focused (i.e. cursor is blinking).
	 */
	hasTextFocus(): boolean;

	/**
	 * Returns all actions associated with this editor.
	 */
	getSupportedActions(): IEditorAction[];

	/**
	 * Saves current view state of the editor in a serializable object.
	 */
	saveViewState(): IEditorViewState | null;

	/**
	 * Restores the view state of the editor from a serializable object generated by `saveViewState`.
	 */
	restoreViewState(state: IEditorViewState): void;

	/**
	 * Given a position, returns a column number that takes tab-widths into account.
	 */
	getVisibleColumnFromPosition(position: IPosition): number;

	/**
	 * Given a position, returns a column number that takes tab-widths into account.
	 * @internal
	 */
	getStatusbarColumn(position: IPosition): number;

	/**
	 * Returns the primary position of the cursor.
	 */
	getPosition(): Position | null;

	/**
	 * Set the primary position of the cursor. This will remove any secondary cursors.
	 * @param position New primary cursor's position
	 */
	setPosition(position: IPosition): void;

	/**
	 * Scroll vertically as necessary and reveal a line.
	 */
	revealLine(lineNumber: number, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically as necessary and reveal a line centered vertically.
	 */
	revealLineInCenter(lineNumber: number, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically as necessary and reveal a line centered vertically only if it lies outside the viewport.
	 */
	revealLineInCenterIfOutsideViewport(lineNumber: number, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically as necessary and reveal a line close to the top of the viewport,
	 * optimized for viewing a code definition.
	 */
	revealLineNearTop(lineNumber: number, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a position.
	 */
	revealPosition(position: IPosition, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a position centered vertically.
	 */
	revealPositionInCenter(position: IPosition, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a position centered vertically only if it lies outside the viewport.
	 */
	revealPositionInCenterIfOutsideViewport(position: IPosition, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a position close to the top of the viewport,
	 * optimized for viewing a code definition.
	 */
	revealPositionNearTop(position: IPosition, scrollType?: ScrollType): void;

	/**
	 * Returns the primary selection of the editor.
	 */
	getSelection(): Selection | null;

	/**
	 * Returns all the selections of the editor.
	 */
	getSelections(): Selection[] | null;

	/**
	 * Set the primary selection of the editor. This will remove any secondary cursors.
	 * @param selection The new selection
	 */
	setSelection(selection: IRange): void;
	/**
	 * Set the primary selection of the editor. This will remove any secondary cursors.
	 * @param selection The new selection
	 */
	setSelection(selection: Range): void;
	/**
	 * Set the primary selection of the editor. This will remove any secondary cursors.
	 * @param selection The new selection
	 */
	setSelection(selection: ISelection): void;
	/**
	 * Set the primary selection of the editor. This will remove any secondary cursors.
	 * @param selection The new selection
	 */
	setSelection(selection: Selection): void;

	/**
	 * Set the selections for all the cursors of the editor.
	 * Cursors will be removed or added, as necessary.
	 */
	setSelections(selections: readonly ISelection[]): void;

	/**
	 * Scroll vertically as necessary and reveal lines.
	 */
	revealLines(startLineNumber: number, endLineNumber: number, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically as necessary and reveal lines centered vertically.
	 */
	revealLinesInCenter(lineNumber: number, endLineNumber: number, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically as necessary and reveal lines centered vertically only if it lies outside the viewport.
	 */
	revealLinesInCenterIfOutsideViewport(lineNumber: number, endLineNumber: number, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically as necessary and reveal lines close to the top of the viewport,
	 * optimized for viewing a code definition.
	 */
	revealLinesNearTop(lineNumber: number, endLineNumber: number, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a range.
	 */
	revealRange(range: IRange, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a range centered vertically.
	 */
	revealRangeInCenter(range: IRange, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a range at the top of the viewport.
	 */
	revealRangeAtTop(range: IRange, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a range centered vertically only if it lies outside the viewport.
	 */
	revealRangeInCenterIfOutsideViewport(range: IRange, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a range close to the top of the viewport,
	 * optimized for viewing a code definition.
	 */
	revealRangeNearTop(range: IRange, scrollType?: ScrollType): void;

	/**
	 * Scroll vertically or horizontally as necessary and reveal a range close to the top of the viewport,
	 * optimized for viewing a code definition. Only if it lies outside the viewport.
	 */
	revealRangeNearTopIfOutsideViewport(range: IRange, scrollType?: ScrollType): void;

	/**
	 * Directly trigger a handler or an editor action.
	 * @param source The source of the call.
	 * @param handlerId The id of the handler or the id of a contribution.
	 * @param payload Extra data to be sent to the handler.
	 */
	trigger(source: string | null | undefined, handlerId: string, payload: any): void;

	/**
	 * Gets the current model attached to this editor.
	 */
	getModel(): IEditorModel | null;

	/**
	 * Sets the current model attached to this editor.
	 * If the previous model was created by the editor via the value key in the options
	 * literal object, it will be destroyed. Otherwise, if the previous model was set
	 * via setModel, or the model key in the options literal object, the previous model
	 * will not be destroyed.
	 * It is safe to call setModel(null) to simply detach the current model from the editor.
	 */
	setModel(model: IEditorModel | null): void;

	/**
	 * Change the decorations. All decorations added through this changeAccessor
	 * will get the ownerId of the editor (meaning they will not show up in other
	 * editors).
	 * @see `ITextModel.changeDecorations`
	 * @internal
	 */
	changeDecorations(callback: (changeAccessor: IModelDecorationsChangeAccessor) => any): any;
}

/**
 * @internal
 */
export interface ICompositeCodeEditor {

	/**
	 * An event that signals that the active editor has changed
	 */
	readonly onDidChangeActiveEditor: Event<ICompositeCodeEditor>;

	/**
	 * The active code editor iff any
	 */
	readonly activeCodeEditor: IEditor | undefined;
	// readonly editors: readonly ICodeEditor[] maybe supported with uris
}


/**
 * An editor contribution that gets created every time a new editor gets created and gets disposed when the editor gets disposed.
 */
export interface IEditorContribution {
	/**
	 * Dispose this contribution.
	 */
	dispose(): void;
	/**
	 * Store view state.
	 */
	saveViewState?(): any;
	/**
	 * Restore view state.
	 */
	restoreViewState?(state: any): void;
}

/**
 * A diff editor contribution that gets created every time a new  diffeditor gets created and gets disposed when the diff editor gets disposed.
 * @internal
 */
export interface IDiffEditorContribution {
	/**
	 * Dispose this contribution.
	 */
	dispose(): void;
}

/**
 * @internal
 */
export interface IThemeDecorationRenderOptions {
	backgroundColor?: string | ThemeColor;

	outline?: string;
	outlineColor?: string | ThemeColor;
	outlineStyle?: string;
	outlineWidth?: string;

	border?: string;
	borderColor?: string | ThemeColor;
	borderRadius?: string;
	borderSpacing?: string;
	borderStyle?: string;
	borderWidth?: string;

	fontStyle?: string;
	fontWeight?: string;
	fontSize?: string;
	textDecoration?: string;
	cursor?: string;
	color?: string | ThemeColor;
	opacity?: string;
	letterSpacing?: string;

	gutterIconPath?: UriComponents;
	gutterIconSize?: string;

	overviewRulerColor?: string | ThemeColor;

	before?: IContentDecorationRenderOptions;
	after?: IContentDecorationRenderOptions;
}

/**
 * @internal
 */
export interface IContentDecorationRenderOptions {
	contentText?: string;
	contentIconPath?: UriComponents;

	border?: string;
	borderColor?: string | ThemeColor;
	borderRadius?: string;
	fontStyle?: string;
	fontWeight?: string;
	fontSize?: string;
	fontFamily?: string;
	textDecoration?: string;
	color?: string | ThemeColor;
	backgroundColor?: string | ThemeColor;

	margin?: string;
	padding?: string;
	width?: string;
	height?: string;
}

/**
 * @internal
 */
export interface IDecorationRenderOptions extends IThemeDecorationRenderOptions {
	isWholeLine?: boolean;
	rangeBehavior?: TrackedRangeStickiness;

	light?: IThemeDecorationRenderOptions;
	dark?: IThemeDecorationRenderOptions;
}

/**
 * @internal
 */
export interface IThemeDecorationInstanceRenderOptions {
	before?: IContentDecorationRenderOptions;
	after?: IContentDecorationRenderOptions;
}

/**
 * @internal
 */
export interface IDecorationInstanceRenderOptions extends IThemeDecorationInstanceRenderOptions {
	light?: IThemeDecorationInstanceRenderOptions;
	dark?: IThemeDecorationInstanceRenderOptions;
}

/**
 * @internal
 */
export interface IDecorationOptions {
	range: IRange;
	hoverMessage?: string | string[];
	renderOptions?: IDecorationInstanceRenderOptions;
}

/**
 * The type of the `IEditor`.
 */
 export const EditorType = {
	ICodeEditor: 'vs.editor.ICodeEditor'
};
