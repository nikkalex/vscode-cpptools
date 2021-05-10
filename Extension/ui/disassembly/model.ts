/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Original file: vscode/src/vs/editor/common/model.ts

import { Event } from './event';
import { IDisposable } from './lifecycle';
import { URI } from './uri';
import { IPosition, Position } from './core/position';
import { IRange, Range } from './core/range';
import { Selection } from './core/selection';
import { IModelContentChange, IModelContentChangedEvent, IModelDecorationsChangedEvent, IModelLanguageChangedEvent, IModelLanguageConfigurationChangedEvent, IModelOptionsChangedEvent, ModelRawContentChangedEvent } from './model/textModelEvents';
import { TextChange } from './model/textChange';

/**
 * Options for a model decoration.
 */
export interface IModelDecorationOptions {
	/**
	 * Customize the growing behavior of the decoration when typing at the edges of the decoration.
	 * Defaults to TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges
	 */
	stickiness?: TrackedRangeStickiness;
	/**
	 * CSS class name describing the decoration.
	 */
	className?: string | null;
	/**
	 * Message to be rendered when hovering over the glyph margin decoration.
	 */
	glyphMarginHoverMessage?: string | string[] | null;
	/**
	 * Array of MarkdownString to render as the decoration message.
	 */
	hoverMessage?: string | string[] | null;
	/**
	 * Should the decoration expand to encompass a whole line.
	 */
	isWholeLine?: boolean;
	/**
	 * Always render the decoration (even when the range it encompasses is collapsed).
	 * @internal
	 */
	showIfCollapsed?: boolean;
	/**
	 * Collapse the decoration if its entire range is being replaced via an edit.
	 * @internal
	 */
	collapseOnReplaceEdit?: boolean;
	/**
	 * Specifies the stack order of a decoration.
	 * A decoration with greater stack order is always in front of a decoration with a lower stack order.
	 */
	zIndex?: number;
	/**
	 * If set, the decoration will be rendered in the glyph margin with this CSS class name.
	 */
	glyphMarginClassName?: string | null;
	/**
	 * If set, the decoration will be rendered in the lines decorations with this CSS class name.
	 */
	linesDecorationsClassName?: string | null;
	/**
	 * If set, the decoration will be rendered in the lines decorations with this CSS class name, but only for the first line in case of line wrapping.
	 */
	firstLineDecorationClassName?: string | null;
	/**
	 * If set, the decoration will be rendered in the margin (covering its full width) with this CSS class name.
	 */
	marginClassName?: string | null;
	/**
	 * If set, the decoration will be rendered inline with the text with this CSS class name.
	 * Please use this only for CSS rules that must impact the text. For example, use `className`
	 * to have a background color decoration.
	 */
	inlineClassName?: string | null;
	/**
	 * If there is an `inlineClassName` which affects letter spacing.
	 */
	inlineClassNameAffectsLetterSpacing?: boolean;
	/**
	 * If set, the decoration will be rendered before the text with this CSS class name.
	 */
	beforeContentClassName?: string | null;
	/**
	 * If set, the decoration will be rendered after the text with this CSS class name.
	 */
	afterContentClassName?: string | null;
}

/**
 * New model decorations.
 */
export interface IModelDeltaDecoration {
	/**
	 * Range that this decoration covers.
	 */
	range: IRange;
	/**
	 * Options associated with this decoration.
	 */
	options: IModelDecorationOptions;
}

/**
 * A decoration in the model.
 */
export interface IModelDecoration {
	/**
	 * Identifier for a decoration.
	 */
	readonly id: string;
	/**
	 * Identifier for a decoration's owner.
	 */
	readonly ownerId: number;
	/**
	 * Range that this decoration covers.
	 */
	readonly range: Range;
	/**
	 * Options associated with this decoration.
	 */
	readonly options: IModelDecorationOptions;
}

/**
 * An accessor that can add, change or remove model decorations.
 * @internal
 */
export interface IModelDecorationsChangeAccessor {
	/**
	 * Add a new decoration.
	 * @param range Range that this decoration covers.
	 * @param options Options associated with this decoration.
	 * @return An unique identifier associated with this decoration.
	 */
	addDecoration(range: IRange, options: IModelDecorationOptions): string;
	/**
	 * Change the range that an existing decoration covers.
	 * @param id The unique identifier associated with the decoration.
	 * @param newRange The new range that this decoration covers.
	 */
	changeDecoration(id: string, newRange: IRange): void;
	/**
	 * Change the options associated with an existing decoration.
	 * @param id The unique identifier associated with the decoration.
	 * @param newOptions The new options associated with this decoration.
	 */
	changeDecorationOptions(id: string, newOptions: IModelDecorationOptions): void;
	/**
	 * Remove an existing decoration.
	 * @param id The unique identifier associated with the decoration.
	 */
	removeDecoration(id: string): void;
	/**
	 * Perform a minimum amount of operations, in order to transform the decorations
	 * identified by `oldDecorations` to the decorations described by `newDecorations`
	 * and returns the new identifiers associated with the resulting decorations.
	 *
	 * @param oldDecorations Array containing previous decorations identifiers.
	 * @param newDecorations Array describing what decorations should result after the call.
	 * @return An array containing the new decorations identifiers.
	 */
	deltaDecorations(oldDecorations: string[], newDecorations: IModelDeltaDecoration[]): string[];
}

/**
 * Word inside a model.
 */
export interface IWordAtPosition {
	/**
	 * The word.
	 */
	readonly word: string;
	/**
	 * The column where the word starts.
	 */
	readonly startColumn: number;
	/**
	 * The column where the word ends.
	 */
	readonly endColumn: number;
}

/**
 * An identifier for a single edit operation.
 * @internal
 */
export interface ISingleEditOperationIdentifier {
	/**
	 * Identifier major
	 */
	major: number;
	/**
	 * Identifier minor
	 */
	minor: number;
}

/**
 * A single edit operation, that acts as a simple replace.
 * i.e. Replace text at `range` with `text` in model.
 */
export interface ISingleEditOperation {
	/**
	 * The range to replace. This can be empty to emulate a simple insert.
	 */
	range: IRange;
	/**
	 * The text to replace with. This can be null to emulate a simple delete.
	 */
	text: string | null;
	/**
	 * This indicates that this operation has "insert" semantics.
	 * i.e. forceMoveMarkers = true => if `range` is collapsed, all markers at the position will be moved.
	 */
	forceMoveMarkers?: boolean;
}

/**
 * A single edit operation, that has an identifier.
 */
export interface IIdentifiedSingleEditOperation {
	/**
	 * An identifier associated with this single edit operation.
	 * @internal
	 */
	identifier?: ISingleEditOperationIdentifier | null;
	/**
	 * The range to replace. This can be empty to emulate a simple insert.
	 */
	range: IRange;
	/**
	 * The text to replace with. This can be null to emulate a simple delete.
	 */
	text: string | null;
	/**
	 * This indicates that this operation has "insert" semantics.
	 * i.e. forceMoveMarkers = true => if `range` is collapsed, all markers at the position will be moved.
	 */
	forceMoveMarkers?: boolean;
	/**
	 * This indicates that this operation is inserting automatic whitespace
	 * that can be removed on next model edit operation if `config.trimAutoWhitespace` is true.
	 * @internal
	 */
	isAutoWhitespaceEdit?: boolean;
	/**
	 * This indicates that this operation is in a set of operations that are tracked and should not be "simplified".
	 * @internal
	 */
	_isTracked?: boolean;
}

export interface IValidEditOperation {
	/**
	 * An identifier associated with this single edit operation.
	 * @internal
	 */
	identifier: ISingleEditOperationIdentifier | null;
	/**
	 * The range to replace. This can be empty to emulate a simple insert.
	 */
	range: Range;
	/**
	 * The text to replace with. This can be empty to emulate a simple delete.
	 */
	text: string;
	/**
	 * @internal
	 */
	textChange: TextChange;
}

/**
 * A callback that can compute the cursor state after applying a series of edit operations.
 */
export interface ICursorStateComputer {
	/**
	 * A callback that can compute the resulting cursors state after some edit operations have been executed.
	 */
	(inverseEditOperations: IValidEditOperation[]): Selection[] | null;
}

export class TextModelResolvedOptions {
	_textModelResolvedOptionsBrand: void;

	readonly tabSize: number;
	readonly indentSize: number;
	readonly insertSpaces: boolean;
	readonly trimAutoWhitespace: boolean;

	/**
	 * @internal
	 */
	constructor(src: {
		tabSize: number;
		indentSize: number;
		insertSpaces: boolean;
		trimAutoWhitespace: boolean;
	}) {
		this.tabSize = Math.max(1, src.tabSize | 0);
		this.indentSize = src.tabSize | 0;
		this.insertSpaces = Boolean(src.insertSpaces);
		this.trimAutoWhitespace = Boolean(src.trimAutoWhitespace);
	}

	/**
	 * @internal
	 */
	public equals(other: TextModelResolvedOptions): boolean {
		return (
			this.tabSize === other.tabSize
			&& this.indentSize === other.indentSize
			&& this.insertSpaces === other.insertSpaces
			&& this.trimAutoWhitespace === other.trimAutoWhitespace
		);
	}

	/**
	 * @internal
	 */
	public createChangeEvent(newOpts: TextModelResolvedOptions): IModelOptionsChangedEvent {
		return {
			tabSize: this.tabSize !== newOpts.tabSize,
			indentSize: this.indentSize !== newOpts.indentSize,
			insertSpaces: this.insertSpaces !== newOpts.insertSpaces,
			trimAutoWhitespace: this.trimAutoWhitespace !== newOpts.trimAutoWhitespace,
		};
	}
}

/**
 * @internal
 */
export interface ITextModelCreationOptions {
	tabSize: number;
	indentSize: number;
	insertSpaces: boolean;
	detectIndentation: boolean;
	trimAutoWhitespace: boolean;
	isForSimpleWidget: boolean;
	largeFileOptimizations: boolean;
}

export interface ITextModelUpdateOptions {
	tabSize?: number;
	indentSize?: number;
	insertSpaces?: boolean;
	trimAutoWhitespace?: boolean;
}

export class FindMatch {
	_findMatchBrand: void;

	public readonly range: Range;
	public readonly matches: string[] | null;

	/**
	 * @internal
	 */
	constructor(range: Range, matches: string[] | null) {
		this.range = range;
		this.matches = matches;
	}
}

/**
 * @internal
 */
export interface IFoundBracket {
	range: Range;
	open: string[];
	close: string[];
	isOpen: boolean;
}

/**
 * Describes the behavior of decorations when typing/editing near their edges.
 * Note: Please do not edit the values, as they very carefully match `DecorationRangeBehavior`
 */
export const enum TrackedRangeStickiness {
	AlwaysGrowsWhenTypingAtEdges = 0,
	NeverGrowsWhenTypingAtEdges = 1,
	GrowsOnlyWhenTypingBefore = 2,
	GrowsOnlyWhenTypingAfter = 3,
}

/**
 * @internal
 */
export interface IActiveIndentGuideInfo {
	startLineNumber: number;
	endLineNumber: number;
	indent: number;
}

/**
 * Text snapshot that works like an iterator.
 * Will try to return chunks of roughly ~64KB size.
 * Will return null when finished.
 *
 * @internal
 */
export interface ITextSnapshot {
	read(): string | null;
}

/**
 * A model.
 */
export interface ITextModel {

	/**
	 * Gets the resource associated with this editor model.
	 */
	readonly uri: URI;

	/**
	 * A unique identifier associated with this model.
	 */
	readonly id: string;

	/**
	 * This model is constructed for a simple widget code editor.
	 * @internal
	 */
	readonly isForSimpleWidget: boolean;

	/**
	 * If true, the text model might contain RTL.
	 * If false, the text model **contains only** contain LTR.
	 * @internal
	 */
	mightContainRTL(): boolean;

	/**
	 * If true, the text model might contain LINE SEPARATOR (LS), PARAGRAPH SEPARATOR (PS).
	 * If false, the text model definitely does not contain these.
	 * @internal
	 */
	mightContainUnusualLineTerminators(): boolean;

	/**
	 * If true, the text model might contain non basic ASCII.
	 * If false, the text model **contains only** basic ASCII.
	 * @internal
	 */
	mightContainNonBasicASCII(): boolean;

	/**
	 * Get the resolved options for this model.
	 */
	getOptions(): TextModelResolvedOptions;

	/**
	 * Replace the entire text buffer value contained in this model.
	 */
	setValue(newValue: string): void;

	/**
	 * Get the text stored in this model.
	 * @param preserverBOM Preserve a BOM character if it was detected when the model was constructed.
	 * @return The text.
	 */
	getValue(preserveBOM?: boolean): string;

	/**
	 * Get the text stored in this model.
	 * @param preserverBOM Preserve a BOM character if it was detected when the model was constructed.
	 * @return The text snapshot (it is safe to consume it asynchronously).
	 * @internal
	 */
	createSnapshot(preserveBOM?: boolean): ITextSnapshot;

	/**
	 * Get the length of the text stored in this model.
	 */
	getValueLength(preserveBOM?: boolean): number;

	/**
	 * Check if the raw text stored in this model equals another raw text.
	 * @internal
	 */
	equalsTextBuffer(other: ITextBuffer): boolean;

	/**
	 * Get the underling text buffer.
	 * @internal
	 */
	getTextBuffer(): ITextBuffer;

	/**
	 * Get the text in a certain range.
	 * @param range The range describing what text to get.
	 * @return The text.
	 */
	getValueInRange(range: IRange): string;

	/**
	 * Get the length of text in a certain range.
	 * @param range The range describing what text length to get.
	 * @return The text length.
	 */
	getValueLengthInRange(range: IRange): number;

	/**
	 * Get the character count of text in a certain range.
	 * @param range The range describing what text length to get.
	 */
	getCharacterCountInRange(range: IRange): number;

	/**
	 * Get the number of lines in the model.
	 */
	getLineCount(): number;

	/**
	 * Get the text for a certain line.
	 */
	getLineContent(lineNumber: number): string;

	/**
	 * Get the text length for a certain line.
	 */
	getLineLength(lineNumber: number): number;

	/**
	 * Get the text for all lines.
	 */
	getLinesContent(): string[];

	/**
	 * Get the minimum legal column for line at `lineNumber`
	 */
	getLineMinColumn(lineNumber: number): number;

	/**
	 * Get the maximum legal column for line at `lineNumber`
	 */
	getLineMaxColumn(lineNumber: number): number;

	/**
	 * Returns the column before the first non whitespace character for line at `lineNumber`.
	 * Returns 0 if line is empty or contains only whitespace.
	 */
	getLineFirstNonWhitespaceColumn(lineNumber: number): number;

	/**
	 * Returns the column after the last non whitespace character for line at `lineNumber`.
	 * Returns 0 if line is empty or contains only whitespace.
	 */
	getLineLastNonWhitespaceColumn(lineNumber: number): number;

	/**
	 * Create a valid position,
	 */
	validatePosition(position: IPosition): Position;

	/**
	 * Advances the given position by the given offset (negative offsets are also accepted)
	 * and returns it as a new valid position.
	 *
	 * If the offset and position are such that their combination goes beyond the beginning or
	 * end of the model, throws an exception.
	 *
	 * If the offset is such that the new position would be in the middle of a multi-byte
	 * line terminator, throws an exception.
	 */
	modifyPosition(position: IPosition, offset: number): Position;

	/**
	 * Create a valid range.
	 */
	validateRange(range: IRange): Range;

	/**
	 * Converts the position to a zero-based offset.
	 *
	 * The position will be [adjusted](#TextDocument.validatePosition).
	 *
	 * @param position A position.
	 * @return A valid zero-based offset.
	 */
	getOffsetAt(position: IPosition): number;

	/**
	 * Converts a zero-based offset to a position.
	 *
	 * @param offset A zero-based offset.
	 * @return A valid [position](#Position).
	 */
	getPositionAt(offset: number): Position;

	/**
	 * Get a range covering the entire model
	 */
	getFullModelRange(): Range;

	/**
	 * Returns if the model was disposed or not.
	 */
	isDisposed(): boolean;

	/**
	 * @internal
	 */
	getActiveIndentGuide(lineNumber: number, minLineNumber: number, maxLineNumber: number): IActiveIndentGuideInfo;

	/**
	 * @internal
	 */
	getLinesIndentGuides(startLineNumber: number, endLineNumber: number): number[];

	/**
	 * Change the decorations. The callback will be called with a change accessor
	 * that becomes invalid as soon as the callback finishes executing.
	 * This allows for all events to be queued up until the change
	 * is completed. Returns whatever the callback returns.
	 * @param ownerId Identifies the editor id in which these decorations should appear. If no `ownerId` is provided, the decorations will appear in all editors that attach this model.
	 * @internal
	 */
	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T, ownerId?: number): T | null;

	/**
	 * Perform a minimum amount of operations, in order to transform the decorations
	 * identified by `oldDecorations` to the decorations described by `newDecorations`
	 * and returns the new identifiers associated with the resulting decorations.
	 *
	 * @param oldDecorations Array containing previous decorations identifiers.
	 * @param newDecorations Array describing what decorations should result after the call.
	 * @param ownerId Identifies the editor id in which these decorations should appear. If no `ownerId` is provided, the decorations will appear in all editors that attach this model.
	 * @return An array containing the new decorations identifiers.
	 */
	deltaDecorations(oldDecorations: string[], newDecorations: IModelDeltaDecoration[], ownerId?: number): string[];

	/**
	 * Remove all decorations that have been added with this specific ownerId.
	 * @param ownerId The owner id to search for.
	 * @internal
	 */
	removeAllDecorationsWithOwnerId(ownerId: number): void;

	/**
	 * Get the options associated with a decoration.
	 * @param id The decoration id.
	 * @return The decoration options or null if the decoration was not found.
	 */
	getDecorationOptions(id: string): IModelDecorationOptions | null;

	/**
	 * Get the range associated with a decoration.
	 * @param id The decoration id.
	 * @return The decoration range or null if the decoration was not found.
	 */
	getDecorationRange(id: string): Range | null;

	/**
	 * Gets all the decorations for the line `lineNumber` as an array.
	 * @param lineNumber The line number
	 * @param ownerId If set, it will ignore decorations belonging to other owners.
	 * @param filterOutValidation If set, it will ignore decorations specific to validation (i.e. warnings, errors).
	 * @return An array with the decorations
	 */
	getLineDecorations(lineNumber: number, ownerId?: number, filterOutValidation?: boolean): IModelDecoration[];

	/**
	 * Gets all the decorations for the lines between `startLineNumber` and `endLineNumber` as an array.
	 * @param startLineNumber The start line number
	 * @param endLineNumber The end line number
	 * @param ownerId If set, it will ignore decorations belonging to other owners.
	 * @param filterOutValidation If set, it will ignore decorations specific to validation (i.e. warnings, errors).
	 * @return An array with the decorations
	 */
	getLinesDecorations(startLineNumber: number, endLineNumber: number, ownerId?: number, filterOutValidation?: boolean): IModelDecoration[];

	/**
	 * Gets all the decorations in a range as an array. Only `startLineNumber` and `endLineNumber` from `range` are used for filtering.
	 * So for now it returns all the decorations on the same line as `range`.
	 * @param range The range to search in
	 * @param ownerId If set, it will ignore decorations belonging to other owners.
	 * @param filterOutValidation If set, it will ignore decorations specific to validation (i.e. warnings, errors).
	 * @return An array with the decorations
	 */
	getDecorationsInRange(range: IRange, ownerId?: number, filterOutValidation?: boolean): IModelDecoration[];

	/**
	 * Gets all the decorations as an array.
	 * @param ownerId If set, it will ignore decorations belonging to other owners.
	 * @param filterOutValidation If set, it will ignore decorations specific to validation (i.e. warnings, errors).
	 */
	getAllDecorations(ownerId?: number, filterOutValidation?: boolean): IModelDecoration[];

	/**
	 * @internal
	 */
	_getTrackedRange(id: string): Range | null;

	/**
	 * @internal
	 */
	_setTrackedRange(id: string | null, newRange: null, newStickiness: TrackedRangeStickiness): null;
	/**
	 * @internal
	 */
	_setTrackedRange(id: string | null, newRange: Range, newStickiness: TrackedRangeStickiness): string;

	/**
	 * Change the options of this model.
	 */
	updateOptions(newOpts: ITextModelUpdateOptions): void;

	/**
	 * Edit the model without adding the edits to the undo stack.
	 * This can have dire consequences on the undo stack! See @pushEditOperations for the preferred way.
	 * @param operations The edit operations.
	 * @return If desired, the inverse edit operations, that, when applied, will bring the model back to the previous state.
	 */
	applyEdits(operations: IIdentifiedSingleEditOperation[]): void | IValidEditOperation[];

	/**
	 * @deprecated Please use `onDidChangeContent` instead.
	 * An event emitted when the contents of the model have changed.
	 * @internal
	 * @event
	 */
	onDidChangeRawContentFast(listener: (e: ModelRawContentChangedEvent) => void): IDisposable;
	/**
	 * @deprecated Please use `onDidChangeContent` instead.
	 * An event emitted when the contents of the model have changed.
	 * @internal
	 * @event
	 */
	onDidChangeRawContent(listener: (e: ModelRawContentChangedEvent) => void): IDisposable;
	/**
	 * An event emitted when the contents of the model have changed.
	 * @event
	 */
	onDidChangeContent(listener: (e: IModelContentChangedEvent) => void): IDisposable;
	/**
	 * An event emitted when decorations of the model have changed.
	 * @event
	 */
	onDidChangeDecorations(listener: (e: IModelDecorationsChangedEvent) => void): IDisposable;
	/**
	 * An event emitted when the model options have changed.
	 * @event
	 */
	onDidChangeOptions(listener: (e: IModelOptionsChangedEvent) => void): IDisposable;
	/**
	 * An event emitted when the language associated with the model has changed.
	 * @event
	 */
	onDidChangeLanguage(listener: (e: IModelLanguageChangedEvent) => void): IDisposable;
	/**
	 * An event emitted when the language configuration associated with the model has changed.
	 * @event
	 */
	onDidChangeLanguageConfiguration(listener: (e: IModelLanguageConfigurationChangedEvent) => void): IDisposable;
	/**
	 * An event emitted when the model has been attached to the first editor or detached from the last editor.
	 * @event
	 * @internal
	 */
	onDidChangeAttached(listener: () => void): IDisposable;
	/**
	 * An event emitted right before disposing the model.
	 * @event
	 */
	onWillDispose(listener: () => void): IDisposable;

	/**
	 * Destroy this model. This will unbind the model from the mode
	 * and make all necessary clean-up to release this object to the GC.
	 */
	dispose(): void;

	/**
	 * @internal
	 */
	onBeforeAttached(): void;

	/**
	 * @internal
	 */
	onBeforeDetached(): void;

	/**
	 * Returns if this model is attached to an editor or not.
	 * @internal
	 */
	isAttachedToEditor(): boolean;

	/**
	 * Returns the count of editors this model is attached to.
	 * @internal
	 */
	getAttachedEditorCount(): number;
}

/**
 * @internal
 */
export interface ITextBufferBuilder {
	acceptChunk(chunk: string): void;
	finish(): ITextBufferFactory;
}

/**
 * @internal
 */
export interface ITextBufferFactory {
	create(): { textBuffer: ITextBuffer; disposable: IDisposable; };
	getFirstLineText(lengthLimit: number): string;
}

/**
 * @internal
 */
export const enum ModelConstants {
	FIRST_LINE_DETECTION_LENGTH_LIMIT = 1000
}

/**
 * @internal
 */
export class ValidAnnotatedEditOperation implements IIdentifiedSingleEditOperation {
	constructor(
		public readonly identifier: ISingleEditOperationIdentifier | null,
		public readonly range: Range,
		public readonly text: string | null,
		public readonly forceMoveMarkers: boolean,
		public readonly isAutoWhitespaceEdit: boolean,
		public readonly _isTracked: boolean,
	) { }
}

/**
 * @internal
 */
export interface IReadonlyTextBuffer {
	onDidChangeContent: Event<void>;
	equals(other: ITextBuffer): boolean;
	mightContainRTL(): boolean;
	mightContainUnusualLineTerminators(): boolean;
	resetMightContainUnusualLineTerminators(): void;
	mightContainNonBasicASCII(): boolean;
	getBOM(): string;
	getEOL(): string;

	getOffsetAt(lineNumber: number, column: number): number;
	getPositionAt(offset: number): Position;
	getRangeAt(offset: number, length: number): Range;

	getValueInRange(range: Range): string;
	createSnapshot(preserveBOM: boolean): ITextSnapshot;
	getValueLengthInRange(range: Range): number;
	getCharacterCountInRange(range: Range): number;
	getLength(): number;
	getLineCount(): number;
	getLinesContent(): string[];
	getLineContent(lineNumber: number): string;
	getLineCharCode(lineNumber: number, index: number): number;
	getCharCode(offset: number): number;
	getLineLength(lineNumber: number): number;
	getLineFirstNonWhitespaceColumn(lineNumber: number): number;
	getLineLastNonWhitespaceColumn(lineNumber: number): number;
}

/**
 * @internal
 */
export interface ITextBuffer extends IReadonlyTextBuffer {
	setEOL(newEOL: '\r\n' | '\n'): void;
	applyEdits(rawOperations: ValidAnnotatedEditOperation[], recordTrimAutoWhitespace: boolean): ApplyEditsResult;
}

/**
 * @internal
 */
export class ApplyEditsResult {

	constructor(
		public readonly reverseEdits: IValidEditOperation[] | null,
		public readonly changes: IInternalModelContentChange[],
		public readonly trimAutoWhitespaceLineNumbers: number[] | null
	) { }

}

/**
 * @internal
 */
export interface IInternalModelContentChange extends IModelContentChange {
	range: Range;
	forceMoveMarkers: boolean;
}
