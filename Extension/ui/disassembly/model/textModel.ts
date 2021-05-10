/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Original file: vscode/src/vs/editor/common/model/textModel.ts

import { CharCode } from '../charCode';
import { onUnexpectedError } from '../errors';
import { Emitter, Event } from '../event';
import { Disposable, IDisposable } from '../lifecycle';
import * as strings from '../strings';
import { URI } from '../uri';
import { EDITOR_MODEL_DEFAULTS } from 'vs/editor/common/config/editorOptions';
import { IPosition, Position } from '../core/position';
import { IRange, Range } from '../core/range';
import { Selection } from '../core/selection';
import * as model from '../model';
import { IntervalNode, IntervalTree } from '../model/intervalTree';
import { PieceTreeTextBufferBuilder } from '../model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder';
import { IModelContentChangedEvent, IModelDecorationsChangedEvent, IModelLanguageChangedEvent, IModelLanguageConfigurationChangedEvent, IModelOptionsChangedEvent, IModelTokensChangedEvent, InternalModelContentChangeEvent, ModelRawChange, ModelRawContentChangedEvent, ModelRawEOLChanged, ModelRawFlush, ModelRawLineChanged, ModelRawLinesDeleted, ModelRawLinesInserted } from '../model/textModelEvents';
import { LanguageIdentifier, FormattingOptions } from '../modes';
import { LanguageConfigurationRegistry } from '../modes/languageConfigurationRegistry';
import { NULL_LANGUAGE_IDENTIFIER } from '../modes/nullMode';
import { VSBufferReadableStream, VSBuffer } from '../buffer';
import { TextChange } from '../model/textChange';
import { Constants } from '../uint';
import { PieceTreeTextBuffer } from '../model/pieceTreeTextBuffer/pieceTreeTextBuffer';
import { listenStream } from '../stream';

function createTextBufferBuilder() {
	return new PieceTreeTextBufferBuilder();
}

export function createTextBufferFactory(text: string): model.ITextBufferFactory {
	const builder = createTextBufferBuilder();
	builder.acceptChunk(text);
	return builder.finish();
}

interface ITextStream {
	on(event: 'data', callback: (data: string) => void): void;
	on(event: 'error', callback: (err: Error) => void): void;
	on(event: 'end', callback: () => void): void;
	on(event: string, callback: any): void;
}

export function createTextBufferFactoryFromStream(stream: ITextStream): Promise<model.ITextBufferFactory>;
export function createTextBufferFactoryFromStream(stream: VSBufferReadableStream): Promise<model.ITextBufferFactory>;
export function createTextBufferFactoryFromStream(stream: ITextStream | VSBufferReadableStream): Promise<model.ITextBufferFactory> {
	return new Promise<model.ITextBufferFactory>((resolve, reject) => {
		const builder = createTextBufferBuilder();

		let done = false;

		listenStream<string | VSBuffer>(stream, {
			onData: chunk => {
				builder.acceptChunk((typeof chunk === 'string') ? chunk : chunk.toString());
			},
			onError: error => {
				if (!done) {
					done = true;
					reject(error);
				}
			},
			onEnd: () => {
				if (!done) {
					done = true;
					resolve(builder.finish());
				}
			}
		});
	});
}

export function createTextBufferFactoryFromSnapshot(snapshot: model.ITextSnapshot): model.ITextBufferFactory {
	let builder = createTextBufferBuilder();

	let chunk: string | null;
	while (typeof (chunk = snapshot.read()) === 'string') {
		builder.acceptChunk(chunk);
	}

	return builder.finish();
}

export function createTextBuffer(value: string | model.ITextBufferFactory): { textBuffer: model.ITextBuffer; disposable: IDisposable; } {
	const factory = (typeof value === 'string' ? createTextBufferFactory(value) : value);
	return factory.create();
}

let MODEL_ID = 0;

export const LONG_LINE_BOUNDARY = 10000;

class TextModelSnapshot implements model.ITextSnapshot {

	private readonly _source: model.ITextSnapshot;
	private _eos: boolean;

	constructor(source: model.ITextSnapshot) {
		this._source = source;
		this._eos = false;
	}

	public read(): string | null {
		if (this._eos) {
			return null;
		}

		let result: string[] = [], resultCnt = 0, resultLength = 0;

		do {
			let tmp = this._source.read();

			if (tmp === null) {
				// end-of-stream
				this._eos = true;
				if (resultCnt === 0) {
					return null;
				} else {
					return result.join('');
				}
			}

			if (tmp.length > 0) {
				result[resultCnt++] = tmp;
				resultLength += tmp.length;
			}

			if (resultLength >= 64 * 1024) {
				return result.join('');
			}
		} while (true);
	}
}

const invalidFunc = () => { throw new Error(`Invalid change accessor`); };

const enum StringOffsetValidationType {
	/**
	 * Even allowed in surrogate pairs
	 */
	Relaxed = 0,
	/**
	 * Not allowed in surrogate pairs
	 */
	SurrogatePairs = 1,
}

export class TextModel extends Disposable implements model.ITextModel {

	public static DEFAULT_CREATION_OPTIONS: model.ITextModelCreationOptions = {
		isForSimpleWidget: false,
		tabSize: EDITOR_MODEL_DEFAULTS.tabSize,
		indentSize: EDITOR_MODEL_DEFAULTS.indentSize,
		insertSpaces: EDITOR_MODEL_DEFAULTS.insertSpaces,
		detectIndentation: false,
		trimAutoWhitespace: EDITOR_MODEL_DEFAULTS.trimAutoWhitespace,
		largeFileOptimizations: EDITOR_MODEL_DEFAULTS.largeFileOptimizations,
	};

	public static resolveOptions(textBuffer: model.ITextBuffer, options: model.ITextModelCreationOptions): model.TextModelResolvedOptions {
		return new model.TextModelResolvedOptions({
			tabSize: options.tabSize,
			indentSize: options.indentSize,
			insertSpaces: options.insertSpaces,
			trimAutoWhitespace: options.trimAutoWhitespace
		});

	}

	//#region Events
	private readonly _onWillDispose: Emitter<void> = this._register(new Emitter<void>());
	public readonly onWillDispose: Event<void> = this._onWillDispose.event;

	private readonly _onDidChangeDecorations: DidChangeDecorationsEmitter = this._register(new DidChangeDecorationsEmitter());
	public readonly onDidChangeDecorations: Event<IModelDecorationsChangedEvent> = this._onDidChangeDecorations.event;

	private readonly _onDidChangeLanguage: Emitter<IModelLanguageChangedEvent> = this._register(new Emitter<IModelLanguageChangedEvent>());
	public readonly onDidChangeLanguage: Event<IModelLanguageChangedEvent> = this._onDidChangeLanguage.event;

	private readonly _onDidChangeLanguageConfiguration: Emitter<IModelLanguageConfigurationChangedEvent> = this._register(new Emitter<IModelLanguageConfigurationChangedEvent>());
	public readonly onDidChangeLanguageConfiguration: Event<IModelLanguageConfigurationChangedEvent> = this._onDidChangeLanguageConfiguration.event;

	private readonly _onDidChangeTokens: Emitter<IModelTokensChangedEvent> = this._register(new Emitter<IModelTokensChangedEvent>());
	public readonly onDidChangeTokens: Event<IModelTokensChangedEvent> = this._onDidChangeTokens.event;

	private readonly _onDidChangeOptions: Emitter<IModelOptionsChangedEvent> = this._register(new Emitter<IModelOptionsChangedEvent>());
	public readonly onDidChangeOptions: Event<IModelOptionsChangedEvent> = this._onDidChangeOptions.event;

	private readonly _onDidChangeAttached: Emitter<void> = this._register(new Emitter<void>());
	public readonly onDidChangeAttached: Event<void> = this._onDidChangeAttached.event;

	private readonly _eventEmitter: DidChangeContentEmitter = this._register(new DidChangeContentEmitter());
	public onDidChangeRawContentFast(listener: (e: ModelRawContentChangedEvent) => void): IDisposable {
		return this._eventEmitter.fastEvent((e: InternalModelContentChangeEvent) => listener(e.rawContentChangedEvent));
	}
	public onDidChangeRawContent(listener: (e: ModelRawContentChangedEvent) => void): IDisposable {
		return this._eventEmitter.slowEvent((e: InternalModelContentChangeEvent) => listener(e.rawContentChangedEvent));
	}
	public onDidChangeContentFast(listener: (e: IModelContentChangedEvent) => void): IDisposable {
		return this._eventEmitter.fastEvent((e: InternalModelContentChangeEvent) => listener(e.contentChangedEvent));
	}
	public onDidChangeContent(listener: (e: IModelContentChangedEvent) => void): IDisposable {
		return this._eventEmitter.slowEvent((e: InternalModelContentChangeEvent) => listener(e.contentChangedEvent));
	}
	//#endregion

	public readonly id: string;
	public readonly isForSimpleWidget: boolean;
	private readonly _associatedResource: URI;
	private _attachedEditorCount: number;
	private _buffer: model.ITextBuffer;
	private _bufferDisposable: IDisposable;
	private _options: model.TextModelResolvedOptions;

	private _isDisposed: boolean;
	private _isDisposing: boolean;

	//#region Decorations
	/**
	 * Used to workaround broken clients that might attempt using a decoration id generated by a different model.
	 * It is not globally unique in order to limit it to one character.
	 */
	private readonly _instanceId: string;
	private _lastDecorationId: number;
	private _decorations: { [decorationId: string]: IntervalNode; };
	private _decorationsTree: IntervalTree;
	//#endregion

	//#region Tokenization
	private _languageIdentifier: LanguageIdentifier;
	private readonly _languageRegistryListener: IDisposable;
	//#endregion

	constructor(
		source: string | model.ITextBufferFactory,
		creationOptions: model.ITextModelCreationOptions,
		languageIdentifier: LanguageIdentifier | null,
		associatedResource: URI | null = null
	) {
		super();

		// Generate a new unique model id
		MODEL_ID++;
		this.id = '$model' + MODEL_ID;
		this.isForSimpleWidget = creationOptions.isForSimpleWidget;
		if (typeof associatedResource === 'undefined' || associatedResource === null) {
			this._associatedResource = URI.parse('inmemory://model/' + MODEL_ID);
		} else {
			this._associatedResource = associatedResource;
		}
		this._attachedEditorCount = 0;

		const { textBuffer, disposable } = createTextBuffer(source);
		this._buffer = textBuffer;
		this._bufferDisposable = disposable;

		this._options = TextModel.resolveOptions(this._buffer, creationOptions);

		this._isDisposed = false;
		this._isDisposing = false;

		this._languageIdentifier = languageIdentifier || NULL_LANGUAGE_IDENTIFIER;

		this._languageRegistryListener = LanguageConfigurationRegistry.onDidChange((e) => {
			if (e.languageIdentifier.id === this._languageIdentifier.id) {
				this._onDidChangeLanguageConfiguration.fire({});
			}
		});

		this._instanceId = strings.singleLetterHash(MODEL_ID);
		this._lastDecorationId = 0;
		this._decorations = Object.create(null);
		this._decorationsTree = new IntervalTree();
	}

	public override dispose(): void {
		this._isDisposing = true;
		this._onWillDispose.fire();
		this._languageRegistryListener.dispose();
		this._isDisposed = true;
		super.dispose();
		this._bufferDisposable.dispose();
		this._isDisposing = false;
		// Manually release reference to previous text buffer to avoid large leaks
		// in case someone leaks a TextModel reference
		const emptyDisposedTextBuffer = new PieceTreeTextBuffer([], '', '\n', false, false, true, true);
		emptyDisposedTextBuffer.dispose();
		this._buffer = emptyDisposedTextBuffer;
	}

	private _assertNotDisposed(): void {
		if (this._isDisposed) {
			throw new Error('Model is disposed!');
		}
	}

	public equalsTextBuffer(other: model.ITextBuffer): boolean {
		this._assertNotDisposed();
		return this._buffer.equals(other);
	}

	public getTextBuffer(): model.ITextBuffer {
		this._assertNotDisposed();
		return this._buffer;
	}

	private _emitContentChangedEvent(rawChange: ModelRawContentChangedEvent, change: IModelContentChangedEvent): void {
		if (this._isDisposing) {
			// Do not confuse listeners by emitting any event after disposing
			return;
		}
		this._eventEmitter.fire(new InternalModelContentChangeEvent(rawChange, change));
	}

	public setValue(value: string): void {
		this._assertNotDisposed();
		if (value === null) {
			// There's nothing to do
			return;
		}

		const { textBuffer, disposable } = createTextBuffer(value);
		this._setValueFromTextBuffer(textBuffer, disposable);
	}

	private _createContentChanged2(range: Range, rangeOffset: number, rangeLength: number, text: string, isUndoing: boolean, isRedoing: boolean, isFlush: boolean): IModelContentChangedEvent {
		return {
			changes: [{
				range: range,
				rangeOffset: rangeOffset,
				rangeLength: rangeLength,
				text: text,
			}],
			isFlush: isFlush
		};
	}

	private _setValueFromTextBuffer(textBuffer: model.ITextBuffer, textBufferDisposable: IDisposable): void {
		this._assertNotDisposed();
		const oldFullModelRange = this.getFullModelRange();
		const oldModelValueLength = this.getValueLengthInRange(oldFullModelRange);
		const endLineNumber = this.getLineCount();
		const endColumn = this.getLineMaxColumn(endLineNumber);

		this._buffer = textBuffer;
		this._bufferDisposable.dispose();
		this._bufferDisposable = textBufferDisposable;

		// Destroy all my decorations
		this._decorations = Object.create(null);
		this._decorationsTree = new IntervalTree();

		this._emitContentChangedEvent(
			new ModelRawContentChangedEvent([new ModelRawFlush()]),
			this._createContentChanged2(new Range(1, 1, endLineNumber, endColumn), 0, oldModelValueLength, this.getValue(), false, false, true)
		);
	}

	public onBeforeAttached(): void {
		this._attachedEditorCount++;
		if (this._attachedEditorCount === 1) {
			this._onDidChangeAttached.fire(undefined);
		}
	}

	public onBeforeDetached(): void {
		this._attachedEditorCount--;
		if (this._attachedEditorCount === 0) {
			this._onDidChangeAttached.fire(undefined);
		}
	}

	public isAttachedToEditor(): boolean {
		return this._attachedEditorCount > 0;
	}

	public getAttachedEditorCount(): number {
		return this._attachedEditorCount;
	}

	public isDisposed(): boolean {
		return this._isDisposed;
	}

	public get uri(): URI {
		return this._associatedResource;
	}

	//#region Options

	public getOptions(): model.TextModelResolvedOptions {
		this._assertNotDisposed();
		return this._options;
	}

	public getFormattingOptions(): FormattingOptions {
		return {
			tabSize: this._options.indentSize,
			insertSpaces: this._options.insertSpaces
		};
	}

	public updateOptions(_newOpts: model.ITextModelUpdateOptions): void {
		this._assertNotDisposed();
		let tabSize = (typeof _newOpts.tabSize !== 'undefined') ? _newOpts.tabSize : this._options.tabSize;
		let indentSize = (typeof _newOpts.indentSize !== 'undefined') ? _newOpts.indentSize : this._options.indentSize;
		let insertSpaces = (typeof _newOpts.insertSpaces !== 'undefined') ? _newOpts.insertSpaces : this._options.insertSpaces;
		let trimAutoWhitespace = (typeof _newOpts.trimAutoWhitespace !== 'undefined') ? _newOpts.trimAutoWhitespace : this._options.trimAutoWhitespace;

		let newOpts = new model.TextModelResolvedOptions({
			tabSize: tabSize,
			indentSize: indentSize,
			insertSpaces: insertSpaces,
			trimAutoWhitespace: trimAutoWhitespace
		});

		if (this._options.equals(newOpts)) {
			return;
		}

		let e = this._options.createChangeEvent(newOpts);
		this._options = newOpts;

		this._onDidChangeOptions.fire(e);
	}

	//#endregion

	//#region Reading

	public mightContainRTL(): boolean {
		return this._buffer.mightContainRTL();
	}

	public mightContainUnusualLineTerminators(): boolean {
		return this._buffer.mightContainUnusualLineTerminators();
	}

	public mightContainNonBasicASCII(): boolean {
		return this._buffer.mightContainNonBasicASCII();
	}

	public getOffsetAt(rawPosition: IPosition): number {
		this._assertNotDisposed();
		let position = this._validatePosition(rawPosition.lineNumber, rawPosition.column, StringOffsetValidationType.Relaxed);
		return this._buffer.getOffsetAt(position.lineNumber, position.column);
	}

	public getPositionAt(rawOffset: number): Position {
		this._assertNotDisposed();
		let offset = (Math.min(this._buffer.getLength(), Math.max(0, rawOffset)));
		return this._buffer.getPositionAt(offset);
	}

	public getValue(preserveBOM: boolean = false): string {
		this._assertNotDisposed();
		const fullModelRange = this.getFullModelRange();
		const fullModelValue = this.getValueInRange(fullModelRange);

		if (preserveBOM) {
			return this._buffer.getBOM() + fullModelValue;
		}

		return fullModelValue;
	}

	public createSnapshot(preserveBOM: boolean = false): model.ITextSnapshot {
		return new TextModelSnapshot(this._buffer.createSnapshot(preserveBOM));
	}

	public getValueLength(preserveBOM: boolean = false): number {
		this._assertNotDisposed();
		const fullModelRange = this.getFullModelRange();
		const fullModelValue = this.getValueLengthInRange(fullModelRange);

		if (preserveBOM) {
			return this._buffer.getBOM().length + fullModelValue;
		}

		return fullModelValue;
	}

	public getValueInRange(rawRange: IRange): string {
		this._assertNotDisposed();
		return this._buffer.getValueInRange(this.validateRange(rawRange));
	}

	public getValueLengthInRange(rawRange: IRange): number {
		this._assertNotDisposed();
		return this._buffer.getValueLengthInRange(this.validateRange(rawRange));
	}

	public getCharacterCountInRange(rawRange: IRange): number {
		this._assertNotDisposed();
		return this._buffer.getCharacterCountInRange(this.validateRange(rawRange));
	}

	public getLineCount(): number {
		this._assertNotDisposed();
		return this._buffer.getLineCount();
	}

	public getLineContent(lineNumber: number): string {
		this._assertNotDisposed();
		if (lineNumber < 1 || lineNumber > this.getLineCount()) {
			throw new Error('Illegal value for lineNumber');
		}

		return this._buffer.getLineContent(lineNumber);
	}

	public getLineLength(lineNumber: number): number {
		this._assertNotDisposed();
		if (lineNumber < 1 || lineNumber > this.getLineCount()) {
			throw new Error('Illegal value for lineNumber');
		}

		return this._buffer.getLineLength(lineNumber);
	}

	public getLinesContent(): string[] {
		this._assertNotDisposed();
		return this._buffer.getLinesContent();
	}


	public getLineMinColumn(lineNumber: number): number {
		this._assertNotDisposed();
		return 1;
	}

	public getLineMaxColumn(lineNumber: number): number {
		this._assertNotDisposed();
		if (lineNumber < 1 || lineNumber > this.getLineCount()) {
			throw new Error('Illegal value for lineNumber');
		}
		return this._buffer.getLineLength(lineNumber) + 1;
	}

	public getLineFirstNonWhitespaceColumn(lineNumber: number): number {
		this._assertNotDisposed();
		if (lineNumber < 1 || lineNumber > this.getLineCount()) {
			throw new Error('Illegal value for lineNumber');
		}
		return this._buffer.getLineFirstNonWhitespaceColumn(lineNumber);
	}

	public getLineLastNonWhitespaceColumn(lineNumber: number): number {
		this._assertNotDisposed();
		if (lineNumber < 1 || lineNumber > this.getLineCount()) {
			throw new Error('Illegal value for lineNumber');
		}
		return this._buffer.getLineLastNonWhitespaceColumn(lineNumber);
	}

	/**
	 * Validates `range` is within buffer bounds, but allows it to sit in between surrogate pairs, etc.
	 * Will try to not allocate if possible.
	 */
	public _validateRangeRelaxedNoAllocations(range: IRange): Range {
		const linesCount = this._buffer.getLineCount();

		const initialStartLineNumber = range.startLineNumber;
		const initialStartColumn = range.startColumn;
		let startLineNumber = Math.floor((typeof initialStartLineNumber === 'number' && !isNaN(initialStartLineNumber)) ? initialStartLineNumber : 1);
		let startColumn = Math.floor((typeof initialStartColumn === 'number' && !isNaN(initialStartColumn)) ? initialStartColumn : 1);

		if (startLineNumber < 1) {
			startLineNumber = 1;
			startColumn = 1;
		} else if (startLineNumber > linesCount) {
			startLineNumber = linesCount;
			startColumn = this.getLineMaxColumn(startLineNumber);
		} else {
			if (startColumn <= 1) {
				startColumn = 1;
			} else {
				const maxColumn = this.getLineMaxColumn(startLineNumber);
				if (startColumn >= maxColumn) {
					startColumn = maxColumn;
				}
			}
		}

		const initialEndLineNumber = range.endLineNumber;
		const initialEndColumn = range.endColumn;
		let endLineNumber = Math.floor((typeof initialEndLineNumber === 'number' && !isNaN(initialEndLineNumber)) ? initialEndLineNumber : 1);
		let endColumn = Math.floor((typeof initialEndColumn === 'number' && !isNaN(initialEndColumn)) ? initialEndColumn : 1);

		if (endLineNumber < 1) {
			endLineNumber = 1;
			endColumn = 1;
		} else if (endLineNumber > linesCount) {
			endLineNumber = linesCount;
			endColumn = this.getLineMaxColumn(endLineNumber);
		} else {
			if (endColumn <= 1) {
				endColumn = 1;
			} else {
				const maxColumn = this.getLineMaxColumn(endLineNumber);
				if (endColumn >= maxColumn) {
					endColumn = maxColumn;
				}
			}
		}

		if (
			initialStartLineNumber === startLineNumber
			&& initialStartColumn === startColumn
			&& initialEndLineNumber === endLineNumber
			&& initialEndColumn === endColumn
			&& range instanceof Range
			&& !(range instanceof Selection)
		) {
			return range;
		}

		return new Range(startLineNumber, startColumn, endLineNumber, endColumn);
	}

	private _isValidPosition(lineNumber: number, column: number, validationType: StringOffsetValidationType): boolean {
		if (typeof lineNumber !== 'number' || typeof column !== 'number') {
			return false;
		}

		if (isNaN(lineNumber) || isNaN(column)) {
			return false;
		}

		if (lineNumber < 1 || column < 1) {
			return false;
		}

		if ((lineNumber | 0) !== lineNumber || (column | 0) !== column) {
			return false;
		}

		const lineCount = this._buffer.getLineCount();
		if (lineNumber > lineCount) {
			return false;
		}

		if (column === 1) {
			return true;
		}

		const maxColumn = this.getLineMaxColumn(lineNumber);
		if (column > maxColumn) {
			return false;
		}

		if (validationType === StringOffsetValidationType.SurrogatePairs) {
			// !!At this point, column > 1
			const charCodeBefore = this._buffer.getLineCharCode(lineNumber, column - 2);
			if (strings.isHighSurrogate(charCodeBefore)) {
				return false;
			}
		}

		return true;
	}

	private _validatePosition(_lineNumber: number, _column: number, validationType: StringOffsetValidationType): Position {
		const lineNumber = Math.floor((typeof _lineNumber === 'number' && !isNaN(_lineNumber)) ? _lineNumber : 1);
		const column = Math.floor((typeof _column === 'number' && !isNaN(_column)) ? _column : 1);
		const lineCount = this._buffer.getLineCount();

		if (lineNumber < 1) {
			return new Position(1, 1);
		}

		if (lineNumber > lineCount) {
			return new Position(lineCount, this.getLineMaxColumn(lineCount));
		}

		if (column <= 1) {
			return new Position(lineNumber, 1);
		}

		const maxColumn = this.getLineMaxColumn(lineNumber);
		if (column >= maxColumn) {
			return new Position(lineNumber, maxColumn);
		}

		if (validationType === StringOffsetValidationType.SurrogatePairs) {
			// If the position would end up in the middle of a high-low surrogate pair,
			// we move it to before the pair
			// !!At this point, column > 1
			const charCodeBefore = this._buffer.getLineCharCode(lineNumber, column - 2);
			if (strings.isHighSurrogate(charCodeBefore)) {
				return new Position(lineNumber, column - 1);
			}
		}

		return new Position(lineNumber, column);
	}

	public validatePosition(position: IPosition): Position {
		const validationType = StringOffsetValidationType.SurrogatePairs;
		this._assertNotDisposed();

		// Avoid object allocation and cover most likely case
		if (position instanceof Position) {
			if (this._isValidPosition(position.lineNumber, position.column, validationType)) {
				return position;
			}
		}

		return this._validatePosition(position.lineNumber, position.column, validationType);
	}

	private _isValidRange(range: Range, validationType: StringOffsetValidationType): boolean {
		const startLineNumber = range.startLineNumber;
		const startColumn = range.startColumn;
		const endLineNumber = range.endLineNumber;
		const endColumn = range.endColumn;

		if (!this._isValidPosition(startLineNumber, startColumn, StringOffsetValidationType.Relaxed)) {
			return false;
		}
		if (!this._isValidPosition(endLineNumber, endColumn, StringOffsetValidationType.Relaxed)) {
			return false;
		}

		if (validationType === StringOffsetValidationType.SurrogatePairs) {
			const charCodeBeforeStart = (startColumn > 1 ? this._buffer.getLineCharCode(startLineNumber, startColumn - 2) : 0);
			const charCodeBeforeEnd = (endColumn > 1 && endColumn <= this._buffer.getLineLength(endLineNumber) ? this._buffer.getLineCharCode(endLineNumber, endColumn - 2) : 0);

			const startInsideSurrogatePair = strings.isHighSurrogate(charCodeBeforeStart);
			const endInsideSurrogatePair = strings.isHighSurrogate(charCodeBeforeEnd);

			if (!startInsideSurrogatePair && !endInsideSurrogatePair) {
				return true;
			}
			return false;
		}

		return true;
	}

	public validateRange(_range: IRange): Range {
		const validationType = StringOffsetValidationType.SurrogatePairs;
		this._assertNotDisposed();

		// Avoid object allocation and cover most likely case
		if ((_range instanceof Range) && !(_range instanceof Selection)) {
			if (this._isValidRange(_range, validationType)) {
				return _range;
			}
		}

		const start = this._validatePosition(_range.startLineNumber, _range.startColumn, StringOffsetValidationType.Relaxed);
		const end = this._validatePosition(_range.endLineNumber, _range.endColumn, StringOffsetValidationType.Relaxed);

		const startLineNumber = start.lineNumber;
		const startColumn = start.column;
		const endLineNumber = end.lineNumber;
		const endColumn = end.column;

		if (validationType === StringOffsetValidationType.SurrogatePairs) {
			const charCodeBeforeStart = (startColumn > 1 ? this._buffer.getLineCharCode(startLineNumber, startColumn - 2) : 0);
			const charCodeBeforeEnd = (endColumn > 1 && endColumn <= this._buffer.getLineLength(endLineNumber) ? this._buffer.getLineCharCode(endLineNumber, endColumn - 2) : 0);

			const startInsideSurrogatePair = strings.isHighSurrogate(charCodeBeforeStart);
			const endInsideSurrogatePair = strings.isHighSurrogate(charCodeBeforeEnd);

			if (!startInsideSurrogatePair && !endInsideSurrogatePair) {
				return new Range(startLineNumber, startColumn, endLineNumber, endColumn);
			}

			if (startLineNumber === endLineNumber && startColumn === endColumn) {
				// do not expand a collapsed range, simply move it to a valid location
				return new Range(startLineNumber, startColumn - 1, endLineNumber, endColumn - 1);
			}

			if (startInsideSurrogatePair && endInsideSurrogatePair) {
				// expand range at both ends
				return new Range(startLineNumber, startColumn - 1, endLineNumber, endColumn + 1);
			}

			if (startInsideSurrogatePair) {
				// only expand range at the start
				return new Range(startLineNumber, startColumn - 1, endLineNumber, endColumn);
			}

			// only expand range at the end
			return new Range(startLineNumber, startColumn, endLineNumber, endColumn + 1);
		}

		return new Range(startLineNumber, startColumn, endLineNumber, endColumn);
	}

	public modifyPosition(rawPosition: IPosition, offset: number): Position {
		this._assertNotDisposed();
		let candidate = this.getOffsetAt(rawPosition) + offset;
		return this.getPositionAt(Math.min(this._buffer.getLength(), Math.max(0, candidate)));
	}

	public getFullModelRange(): Range {
		this._assertNotDisposed();
		const lineCount = this.getLineCount();
		return new Range(1, 1, lineCount, this.getLineMaxColumn(lineCount));
	}

	//#endregion

	//#region Editing

	private _validateEditOperation(rawOperation: model.IIdentifiedSingleEditOperation): model.ValidAnnotatedEditOperation {
		if (rawOperation instanceof model.ValidAnnotatedEditOperation) {
			return rawOperation;
		}
		return new model.ValidAnnotatedEditOperation(
			rawOperation.identifier || null,
			this.validateRange(rawOperation.range),
			rawOperation.text,
			rawOperation.forceMoveMarkers || false,
			rawOperation.isAutoWhitespaceEdit || false,
			rawOperation._isTracked || false
		);
	}

	private _validateEditOperations(rawOperations: model.IIdentifiedSingleEditOperation[]): model.ValidAnnotatedEditOperation[] {
		const result: model.ValidAnnotatedEditOperation[] = [];
		for (let i = 0, len = rawOperations.length; i < len; i++) {
			result[i] = this._validateEditOperation(rawOperations[i]);
		}
		return result;
	}

	public applyEdits(rawOperations: model.IIdentifiedSingleEditOperation[]): void | model.IValidEditOperation[] {
		try {
			this._onDidChangeDecorations.beginDeferredEmit();
			this._eventEmitter.beginDeferredEmit();
			const operations = this._validateEditOperations(rawOperations);
			return this._doApplyEdits(operations);
		} finally {
			this._eventEmitter.endDeferredEmit();
			this._onDidChangeDecorations.endDeferredEmit();
		}
	}

	private _doApplyEdits(rawOperations: model.ValidAnnotatedEditOperation[]): void | model.IValidEditOperation[] {

		const oldLineCount = this._buffer.getLineCount();
		const result = this._buffer.applyEdits(rawOperations, this._options.trimAutoWhitespace);
		const newLineCount = this._buffer.getLineCount();

		const contentChanges = result.changes;
		this._trimAutoWhitespaceLines = result.trimAutoWhitespaceLineNumbers;

		if (contentChanges.length !== 0) {
			let rawContentChanges: ModelRawChange[] = [];

			let lineCount = oldLineCount;
			for (let i = 0, len = contentChanges.length; i < len; i++) {
				const change = contentChanges[i];
				const [eolCount, firstLineLength, lastLineLength] = countEOL(change.text);
				this._onDidChangeDecorations.fire();
				this._decorationsTree.acceptReplace(change.rangeOffset, change.rangeLength, change.text.length, change.forceMoveMarkers);

				const startLineNumber = change.range.startLineNumber;
				const endLineNumber = change.range.endLineNumber;

				const deletingLinesCnt = endLineNumber - startLineNumber;
				const insertingLinesCnt = eolCount;
				const editingLinesCnt = Math.min(deletingLinesCnt, insertingLinesCnt);

				const changeLineCountDelta = (insertingLinesCnt - deletingLinesCnt);

				for (let j = editingLinesCnt; j >= 0; j--) {
					const editLineNumber = startLineNumber + j;
					const currentEditLineNumber = newLineCount - lineCount - changeLineCountDelta + editLineNumber;
					rawContentChanges.push(new ModelRawLineChanged(editLineNumber, this.getLineContent(currentEditLineNumber)));
				}

				if (editingLinesCnt < deletingLinesCnt) {
					// Must delete some lines
					const spliceStartLineNumber = startLineNumber + editingLinesCnt;
					rawContentChanges.push(new ModelRawLinesDeleted(spliceStartLineNumber + 1, endLineNumber));
				}

				if (editingLinesCnt < insertingLinesCnt) {
					// Must insert some lines
					const spliceLineNumber = startLineNumber + editingLinesCnt;
					const cnt = insertingLinesCnt - editingLinesCnt;
					const fromLineNumber = newLineCount - lineCount - cnt + spliceLineNumber + 1;
					let newLines: string[] = [];
					for (let i = 0; i < cnt; i++) {
						let lineNumber = fromLineNumber + i;
						newLines[lineNumber - fromLineNumber] = this.getLineContent(lineNumber);
					}
					rawContentChanges.push(new ModelRawLinesInserted(spliceLineNumber + 1, startLineNumber + insertingLinesCnt, newLines));
				}

				lineCount += changeLineCountDelta;
			}

			this._emitContentChangedEvent(
				new ModelRawContentChangedEvent(rawContentChanges),
				{
					changes: contentChanges,
					isFlush: false
				}
			);
		}

		return (result.reverseEdits === null ? undefined : result.reverseEdits);
	}

	//#endregion

	//#region Decorations

	public changeDecorations<T>(callback: (changeAccessor: model.IModelDecorationsChangeAccessor) => T, ownerId: number = 0): T | null {
		this._assertNotDisposed();

		try {
			this._onDidChangeDecorations.beginDeferredEmit();
			return this._changeDecorations(ownerId, callback);
		} finally {
			this._onDidChangeDecorations.endDeferredEmit();
		}
	}

	private _changeDecorations<T>(ownerId: number, callback: (changeAccessor: model.IModelDecorationsChangeAccessor) => T): T | null {
		let changeAccessor: model.IModelDecorationsChangeAccessor = {
			addDecoration: (range: IRange, options: model.IModelDecorationOptions): string => {
				return this._deltaDecorationsImpl(ownerId, [], [{ range: range, options: options }])[0];
			},
			changeDecoration: (id: string, newRange: IRange): void => {
				this._changeDecorationImpl(id, newRange);
			},
			changeDecorationOptions: (id: string, options: model.IModelDecorationOptions) => {
				this._changeDecorationOptionsImpl(id, _normalizeOptions(options));
			},
			removeDecoration: (id: string): void => {
				this._deltaDecorationsImpl(ownerId, [id], []);
			},
			deltaDecorations: (oldDecorations: string[], newDecorations: model.IModelDeltaDecoration[]): string[] => {
				if (oldDecorations.length === 0 && newDecorations.length === 0) {
					// nothing to do
					return [];
				}
				return this._deltaDecorationsImpl(ownerId, oldDecorations, newDecorations);
			}
		};
		let result: T | null = null;
		try {
			result = callback(changeAccessor);
		} catch (e) {
			onUnexpectedError(e);
		}
		// Invalidate change accessor
		changeAccessor.addDecoration = invalidFunc;
		changeAccessor.changeDecoration = invalidFunc;
		changeAccessor.changeDecorationOptions = invalidFunc;
		changeAccessor.removeDecoration = invalidFunc;
		changeAccessor.deltaDecorations = invalidFunc;
		return result;
	}

	public deltaDecorations(oldDecorations: string[], newDecorations: model.IModelDeltaDecoration[], ownerId: number = 0): string[] {
		this._assertNotDisposed();
		if (!oldDecorations) {
			oldDecorations = [];
		}
		if (oldDecorations.length === 0 && newDecorations.length === 0) {
			// nothing to do
			return [];
		}

		try {
			this._onDidChangeDecorations.beginDeferredEmit();
			return this._deltaDecorationsImpl(ownerId, oldDecorations, newDecorations);
		} finally {
			this._onDidChangeDecorations.endDeferredEmit();
		}
	}

	_getTrackedRange(id: string): Range | null {
		return this.getDecorationRange(id);
	}

	_setTrackedRange(id: string | null, newRange: null, newStickiness: model.TrackedRangeStickiness): null;
	_setTrackedRange(id: string | null, newRange: Range, newStickiness: model.TrackedRangeStickiness): string;
	_setTrackedRange(id: string | null, newRange: Range | null, newStickiness: model.TrackedRangeStickiness): string | null {
		const node = (id ? this._decorations[id] : null);

		if (!node) {
			if (!newRange) {
				// node doesn't exist, the request is to delete => nothing to do
				return null;
			}
			// node doesn't exist, the request is to set => add the tracked range
			return this._deltaDecorationsImpl(0, [], [{ range: newRange, options: TRACKED_RANGE_OPTIONS[newStickiness] }])[0];
		}

		if (!newRange) {
			// node exists, the request is to delete => delete node
			this._decorationsTree.delete(node);
			delete this._decorations[node.id];
			return null;
		}

		// node exists, the request is to set => change the tracked range and its options
		const range = this._validateRangeRelaxedNoAllocations(newRange);
		const startOffset = this._buffer.getOffsetAt(range.startLineNumber, range.startColumn);
		const endOffset = this._buffer.getOffsetAt(range.endLineNumber, range.endColumn);
		this._decorationsTree.delete(node);
		node.reset(this.getVersionId(), startOffset, endOffset, range);
		node.setOptions(TRACKED_RANGE_OPTIONS[newStickiness]);
		this._decorationsTree.insert(node);
		return node.id;
	}

	public removeAllDecorationsWithOwnerId(ownerId: number): void {
		if (this._isDisposed) {
			return;
		}
		const nodes = this._decorationsTree.collectNodesFromOwner(ownerId);
		for (let i = 0, len = nodes.length; i < len; i++) {
			const node = nodes[i];

			this._decorationsTree.delete(node);
			delete this._decorations[node.id];
		}
	}

	public getDecorationOptions(decorationId: string): model.IModelDecorationOptions | null {
		const node = this._decorations[decorationId];
		if (!node) {
			return null;
		}
		return node.options;
	}

	public getDecorationRange(decorationId: string): Range | null {
		const node = this._decorations[decorationId];
		if (!node) {
			return null;
		}
		const versionId = this.getVersionId();
		if (node.cachedVersionId !== versionId) {
			this._decorationsTree.resolveNode(node, versionId);
		}
		if (node.range === null) {
			node.range = this._getRangeAt(node.cachedAbsoluteStart, node.cachedAbsoluteEnd);
		}
		return node.range;
	}

	public getLineDecorations(lineNumber: number, ownerId: number = 0, filterOutValidation: boolean = false): model.IModelDecoration[] {
		if (lineNumber < 1 || lineNumber > this.getLineCount()) {
			return [];
		}

		return this.getLinesDecorations(lineNumber, lineNumber, ownerId, filterOutValidation);
	}

	public getLinesDecorations(_startLineNumber: number, _endLineNumber: number, ownerId: number = 0, filterOutValidation: boolean = false): model.IModelDecoration[] {
		let lineCount = this.getLineCount();
		let startLineNumber = Math.min(lineCount, Math.max(1, _startLineNumber));
		let endLineNumber = Math.min(lineCount, Math.max(1, _endLineNumber));
		let endColumn = this.getLineMaxColumn(endLineNumber);
		return this._getDecorationsInRange(new Range(startLineNumber, 1, endLineNumber, endColumn), ownerId, filterOutValidation);
	}

	public getDecorationsInRange(range: IRange, ownerId: number = 0, filterOutValidation: boolean = false): model.IModelDecoration[] {
		let validatedRange = this.validateRange(range);
		return this._getDecorationsInRange(validatedRange, ownerId, filterOutValidation);
	}

	public getAllDecorations(ownerId: number = 0, filterOutValidation: boolean = false): model.IModelDecoration[] {
		const result = this._decorationsTree.search(ownerId, filterOutValidation, false);
		return this._ensureNodesHaveRanges(result);
	}

	private _getDecorationsInRange(filterRange: Range, filterOwnerId: number, filterOutValidation: boolean): IntervalNode[] {
		const startOffset = this._buffer.getOffsetAt(filterRange.startLineNumber, filterRange.startColumn);
		const endOffset = this._buffer.getOffsetAt(filterRange.endLineNumber, filterRange.endColumn);

		const result = this._decorationsTree.intervalSearch(startOffset, endOffset, filterOwnerId, filterOutValidation);

		return this._ensureNodesHaveRanges(result);
	}

	private _ensureNodesHaveRanges(nodes: IntervalNode[]): IntervalNode[] {
		for (let i = 0, len = nodes.length; i < len; i++) {
			const node = nodes[i];
			if (node.range === null) {
				node.range = this._getRangeAt(node.cachedAbsoluteStart, node.cachedAbsoluteEnd);
			}
		}
		return nodes;
	}

	private _getRangeAt(start: number, end: number): Range {
		return this._buffer.getRangeAt(start, end - start);
	}

	private _changeDecorationImpl(decorationId: string, _range: IRange): void {
		const node = this._decorations[decorationId];
		if (!node) {
			return;
		}
		const range = this._validateRangeRelaxedNoAllocations(_range);
		const startOffset = this._buffer.getOffsetAt(range.startLineNumber, range.startColumn);
		const endOffset = this._buffer.getOffsetAt(range.endLineNumber, range.endColumn);

		this._decorationsTree.delete(node);
		node.reset(this.getVersionId(), startOffset, endOffset, range);
		this._decorationsTree.insert(node);
		this._onDidChangeDecorations.checkAffectedAndFire(node.options);
	}

	private _changeDecorationOptionsImpl(decorationId: string, options: ModelDecorationOptions): void {
		const node = this._decorations[decorationId];
		if (!node) {
			return;
		}

		this._onDidChangeDecorations.checkAffectedAndFire(node.options);
		this._onDidChangeDecorations.checkAffectedAndFire(options);

		node.setOptions(options);
	}

	private _deltaDecorationsImpl(ownerId: number, oldDecorationsIds: string[], newDecorations: model.IModelDeltaDecoration[]): string[] {
		const oldDecorationsLen = oldDecorationsIds.length;
		let oldDecorationIndex = 0;

		const newDecorationsLen = newDecorations.length;
		let newDecorationIndex = 0;

		let result = new Array<string>(newDecorationsLen);
		while (oldDecorationIndex < oldDecorationsLen || newDecorationIndex < newDecorationsLen) {

			let node: IntervalNode | null = null;

			if (oldDecorationIndex < oldDecorationsLen) {
				// (1) get ourselves an old node
				do {
					node = this._decorations[oldDecorationsIds[oldDecorationIndex++]];
				} while (!node && oldDecorationIndex < oldDecorationsLen);

				// (2) remove the node from the tree (if it exists)
				if (node) {
					this._decorationsTree.delete(node);
					this._onDidChangeDecorations.fire();
				}
			}

			if (newDecorationIndex < newDecorationsLen) {
				// (3) create a new node if necessary
				if (!node) {
					const internalDecorationId = (++this._lastDecorationId);
					const decorationId = `${this._instanceId};${internalDecorationId}`;
					node = new IntervalNode(decorationId, 0, 0);
					this._decorations[decorationId] = node;
				}

				// (4) initialize node
				const newDecoration = newDecorations[newDecorationIndex];
				const range = this._validateRangeRelaxedNoAllocations(newDecoration.range);
				const options = _normalizeOptions(newDecoration.options);
				const startOffset = this._buffer.getOffsetAt(range.startLineNumber, range.startColumn);
				const endOffset = this._buffer.getOffsetAt(range.endLineNumber, range.endColumn);

				node.ownerId = ownerId;
				node.reset(versionId, startOffset, endOffset, range);
				node.setOptions(options);
				this._onDidChangeDecorations.fire();

				this._decorationsTree.insert(node);

				result[newDecorationIndex] = node.id;

				newDecorationIndex++;
			} else {
				if (node) {
					delete this._decorations[node.id];
				}
			}
		}

		return result;
	}

	//#endregion

	//#region Tokenization

	/**
	 * Returns:
	 *  - -1 => the line consists of whitespace
	 *  - otherwise => the indent level is returned value
	 */
	public static computeIndentLevel(line: string, tabSize: number): number {
		let indent = 0;
		let i = 0;
		let len = line.length;

		while (i < len) {
			let chCode = line.charCodeAt(i);
			if (chCode === CharCode.Space) {
				indent++;
			} else if (chCode === CharCode.Tab) {
				indent = indent - indent % tabSize + tabSize;
			} else {
				break;
			}
			i++;
		}

		if (i === len) {
			return -1; // line only consists of whitespace
		}

		return indent;
	}

	private _computeIndentLevel(lineIndex: number): number {
		return TextModel.computeIndentLevel(this._buffer.getLineContent(lineIndex + 1), this._options.tabSize);
	}

	public getActiveIndentGuide(lineNumber: number, minLineNumber: number, maxLineNumber: number): model.IActiveIndentGuideInfo {
		this._assertNotDisposed();
		const lineCount = this.getLineCount();

		if (lineNumber < 1 || lineNumber > lineCount) {
			throw new Error('Illegal value for lineNumber');
		}

		const foldingRules = LanguageConfigurationRegistry.getFoldingRules(this._languageIdentifier.id);
		const offSide = Boolean(foldingRules && foldingRules.offSide);

		let up_aboveContentLineIndex = -2; /* -2 is a marker for not having computed it */
		let up_aboveContentLineIndent = -1;
		let up_belowContentLineIndex = -2; /* -2 is a marker for not having computed it */
		let up_belowContentLineIndent = -1;
		const up_resolveIndents = (lineNumber: number) => {
			if (up_aboveContentLineIndex !== -1 && (up_aboveContentLineIndex === -2 || up_aboveContentLineIndex > lineNumber - 1)) {
				up_aboveContentLineIndex = -1;
				up_aboveContentLineIndent = -1;

				// must find previous line with content
				for (let lineIndex = lineNumber - 2; lineIndex >= 0; lineIndex--) {
					let indent = this._computeIndentLevel(lineIndex);
					if (indent >= 0) {
						up_aboveContentLineIndex = lineIndex;
						up_aboveContentLineIndent = indent;
						break;
					}
				}
			}

			if (up_belowContentLineIndex === -2) {
				up_belowContentLineIndex = -1;
				up_belowContentLineIndent = -1;

				// must find next line with content
				for (let lineIndex = lineNumber; lineIndex < lineCount; lineIndex++) {
					let indent = this._computeIndentLevel(lineIndex);
					if (indent >= 0) {
						up_belowContentLineIndex = lineIndex;
						up_belowContentLineIndent = indent;
						break;
					}
				}
			}
		};

		let down_aboveContentLineIndex = -2; /* -2 is a marker for not having computed it */
		let down_aboveContentLineIndent = -1;
		let down_belowContentLineIndex = -2; /* -2 is a marker for not having computed it */
		let down_belowContentLineIndent = -1;
		const down_resolveIndents = (lineNumber: number) => {
			if (down_aboveContentLineIndex === -2) {
				down_aboveContentLineIndex = -1;
				down_aboveContentLineIndent = -1;

				// must find previous line with content
				for (let lineIndex = lineNumber - 2; lineIndex >= 0; lineIndex--) {
					let indent = this._computeIndentLevel(lineIndex);
					if (indent >= 0) {
						down_aboveContentLineIndex = lineIndex;
						down_aboveContentLineIndent = indent;
						break;
					}
				}
			}

			if (down_belowContentLineIndex !== -1 && (down_belowContentLineIndex === -2 || down_belowContentLineIndex < lineNumber - 1)) {
				down_belowContentLineIndex = -1;
				down_belowContentLineIndent = -1;

				// must find next line with content
				for (let lineIndex = lineNumber; lineIndex < lineCount; lineIndex++) {
					let indent = this._computeIndentLevel(lineIndex);
					if (indent >= 0) {
						down_belowContentLineIndex = lineIndex;
						down_belowContentLineIndent = indent;
						break;
					}
				}
			}
		};

		let startLineNumber = 0;
		let goUp = true;
		let endLineNumber = 0;
		let goDown = true;
		let indent = 0;

		let initialIndent = 0;

		for (let distance = 0; goUp || goDown; distance++) {
			const upLineNumber = lineNumber - distance;
			const downLineNumber = lineNumber + distance;

			if (distance > 1 && (upLineNumber < 1 || upLineNumber < minLineNumber)) {
				goUp = false;
			}
			if (distance > 1 && (downLineNumber > lineCount || downLineNumber > maxLineNumber)) {
				goDown = false;
			}
			if (distance > 50000) {
				// stop processing
				goUp = false;
				goDown = false;
			}

			let upLineIndentLevel: number = -1;
			if (goUp) {
				// compute indent level going up
				const currentIndent = this._computeIndentLevel(upLineNumber - 1);
				if (currentIndent >= 0) {
					// This line has content (besides whitespace)
					// Use the line's indent
					up_belowContentLineIndex = upLineNumber - 1;
					up_belowContentLineIndent = currentIndent;
					upLineIndentLevel = Math.ceil(currentIndent / this._options.indentSize);
				} else {
					up_resolveIndents(upLineNumber);
					upLineIndentLevel = this._getIndentLevelForWhitespaceLine(offSide, up_aboveContentLineIndent, up_belowContentLineIndent);
				}
			}

			let downLineIndentLevel = -1;
			if (goDown) {
				// compute indent level going down
				const currentIndent = this._computeIndentLevel(downLineNumber - 1);
				if (currentIndent >= 0) {
					// This line has content (besides whitespace)
					// Use the line's indent
					down_aboveContentLineIndex = downLineNumber - 1;
					down_aboveContentLineIndent = currentIndent;
					downLineIndentLevel = Math.ceil(currentIndent / this._options.indentSize);
				} else {
					down_resolveIndents(downLineNumber);
					downLineIndentLevel = this._getIndentLevelForWhitespaceLine(offSide, down_aboveContentLineIndent, down_belowContentLineIndent);
				}
			}

			if (distance === 0) {
				initialIndent = upLineIndentLevel;
				continue;
			}

			if (distance === 1) {
				if (downLineNumber <= lineCount && downLineIndentLevel >= 0 && initialIndent + 1 === downLineIndentLevel) {
					// This is the beginning of a scope, we have special handling here, since we want the
					// child scope indent to be active, not the parent scope
					goUp = false;
					startLineNumber = downLineNumber;
					endLineNumber = downLineNumber;
					indent = downLineIndentLevel;
					continue;
				}

				if (upLineNumber >= 1 && upLineIndentLevel >= 0 && upLineIndentLevel - 1 === initialIndent) {
					// This is the end of a scope, just like above
					goDown = false;
					startLineNumber = upLineNumber;
					endLineNumber = upLineNumber;
					indent = upLineIndentLevel;
					continue;
				}

				startLineNumber = lineNumber;
				endLineNumber = lineNumber;
				indent = initialIndent;
				if (indent === 0) {
					// No need to continue
					return { startLineNumber, endLineNumber, indent };
				}
			}

			if (goUp) {
				if (upLineIndentLevel >= indent) {
					startLineNumber = upLineNumber;
				} else {
					goUp = false;
				}
			}
			if (goDown) {
				if (downLineIndentLevel >= indent) {
					endLineNumber = downLineNumber;
				} else {
					goDown = false;
				}
			}
		}

		return { startLineNumber, endLineNumber, indent };
	}

	public getLinesIndentGuides(startLineNumber: number, endLineNumber: number): number[] {
		this._assertNotDisposed();
		const lineCount = this.getLineCount();

		if (startLineNumber < 1 || startLineNumber > lineCount) {
			throw new Error('Illegal value for startLineNumber');
		}
		if (endLineNumber < 1 || endLineNumber > lineCount) {
			throw new Error('Illegal value for endLineNumber');
		}

		const foldingRules = LanguageConfigurationRegistry.getFoldingRules(this._languageIdentifier.id);
		const offSide = Boolean(foldingRules && foldingRules.offSide);

		let result: number[] = new Array<number>(endLineNumber - startLineNumber + 1);

		let aboveContentLineIndex = -2; /* -2 is a marker for not having computed it */
		let aboveContentLineIndent = -1;

		let belowContentLineIndex = -2; /* -2 is a marker for not having computed it */
		let belowContentLineIndent = -1;

		for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber++) {
			let resultIndex = lineNumber - startLineNumber;

			const currentIndent = this._computeIndentLevel(lineNumber - 1);
			if (currentIndent >= 0) {
				// This line has content (besides whitespace)
				// Use the line's indent
				aboveContentLineIndex = lineNumber - 1;
				aboveContentLineIndent = currentIndent;
				result[resultIndex] = Math.ceil(currentIndent / this._options.indentSize);
				continue;
			}

			if (aboveContentLineIndex === -2) {
				aboveContentLineIndex = -1;
				aboveContentLineIndent = -1;

				// must find previous line with content
				for (let lineIndex = lineNumber - 2; lineIndex >= 0; lineIndex--) {
					let indent = this._computeIndentLevel(lineIndex);
					if (indent >= 0) {
						aboveContentLineIndex = lineIndex;
						aboveContentLineIndent = indent;
						break;
					}
				}
			}

			if (belowContentLineIndex !== -1 && (belowContentLineIndex === -2 || belowContentLineIndex < lineNumber - 1)) {
				belowContentLineIndex = -1;
				belowContentLineIndent = -1;

				// must find next line with content
				for (let lineIndex = lineNumber; lineIndex < lineCount; lineIndex++) {
					let indent = this._computeIndentLevel(lineIndex);
					if (indent >= 0) {
						belowContentLineIndex = lineIndex;
						belowContentLineIndent = indent;
						break;
					}
				}
			}

			result[resultIndex] = this._getIndentLevelForWhitespaceLine(offSide, aboveContentLineIndent, belowContentLineIndent);

		}
		return result;
	}

	private _getIndentLevelForWhitespaceLine(offSide: boolean, aboveContentLineIndent: number, belowContentLineIndent: number): number {
		if (aboveContentLineIndent === -1 || belowContentLineIndent === -1) {
			// At the top or bottom of the file
			return 0;

		} else if (aboveContentLineIndent < belowContentLineIndent) {
			// we are inside the region above
			return (1 + Math.floor(aboveContentLineIndent / this._options.indentSize));

		} else if (aboveContentLineIndent === belowContentLineIndent) {
			// we are in between two regions
			return Math.ceil(belowContentLineIndent / this._options.indentSize);

		} else {

			if (offSide) {
				// same level as region below
				return Math.ceil(belowContentLineIndent / this._options.indentSize);
			} else {
				// we are inside the region that ends below
				return (1 + Math.floor(belowContentLineIndent / this._options.indentSize));
			}

		}
	}

	//#endregion
}

//#region Decorations

function cleanClassName(className: string): string {
	return className.replace(/[^a-z0-9\-_]/gi, ' ');
}

export class ModelDecorationOptions implements model.IModelDecorationOptions {

	public static EMPTY: ModelDecorationOptions;

	public static register(options: model.IModelDecorationOptions): ModelDecorationOptions {
		return new ModelDecorationOptions(options);
	}

	public static createDynamic(options: model.IModelDecorationOptions): ModelDecorationOptions {
		return new ModelDecorationOptions(options);
	}

	readonly stickiness: model.TrackedRangeStickiness;
	readonly zIndex: number;
	readonly className: string | null;
	readonly hoverMessage: string | string[] | null;
	readonly glyphMarginHoverMessage: string | string[] | null;
	readonly isWholeLine: boolean;
	readonly showIfCollapsed: boolean;
	readonly collapseOnReplaceEdit: boolean;
	readonly glyphMarginClassName: string | null;
	readonly linesDecorationsClassName: string | null;
	readonly firstLineDecorationClassName: string | null;
	readonly marginClassName: string | null;
	readonly inlineClassName: string | null;
	readonly inlineClassNameAffectsLetterSpacing: boolean;
	readonly beforeContentClassName: string | null;
	readonly afterContentClassName: string | null;

	private constructor(options: model.IModelDecorationOptions) {
		this.stickiness = options.stickiness || model.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges;
		this.zIndex = options.zIndex || 0;
		this.className = options.className ? cleanClassName(options.className) : null;
		this.hoverMessage = options.hoverMessage || null;
		this.glyphMarginHoverMessage = options.glyphMarginHoverMessage || null;
		this.isWholeLine = options.isWholeLine || false;
		this.showIfCollapsed = options.showIfCollapsed || false;
		this.collapseOnReplaceEdit = options.collapseOnReplaceEdit || false;
		this.glyphMarginClassName = options.glyphMarginClassName ? cleanClassName(options.glyphMarginClassName) : null;
		this.linesDecorationsClassName = options.linesDecorationsClassName ? cleanClassName(options.linesDecorationsClassName) : null;
		this.firstLineDecorationClassName = options.firstLineDecorationClassName ? cleanClassName(options.firstLineDecorationClassName) : null;
		this.marginClassName = options.marginClassName ? cleanClassName(options.marginClassName) : null;
		this.inlineClassName = options.inlineClassName ? cleanClassName(options.inlineClassName) : null;
		this.inlineClassNameAffectsLetterSpacing = options.inlineClassNameAffectsLetterSpacing || false;
		this.beforeContentClassName = options.beforeContentClassName ? cleanClassName(options.beforeContentClassName) : null;
		this.afterContentClassName = options.afterContentClassName ? cleanClassName(options.afterContentClassName) : null;
	}
}
ModelDecorationOptions.EMPTY = ModelDecorationOptions.register({});

/**
 * The order carefully matches the values of the enum.
 */
const TRACKED_RANGE_OPTIONS = [
	ModelDecorationOptions.register({ stickiness: model.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges }),
	ModelDecorationOptions.register({ stickiness: model.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }),
	ModelDecorationOptions.register({ stickiness: model.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore }),
	ModelDecorationOptions.register({ stickiness: model.TrackedRangeStickiness.GrowsOnlyWhenTypingAfter }),
];

function _normalizeOptions(options: model.IModelDecorationOptions): ModelDecorationOptions {
	if (options instanceof ModelDecorationOptions) {
		return options;
	}
	return ModelDecorationOptions.createDynamic(options);
}

export class DidChangeDecorationsEmitter extends Disposable {

	private readonly _actual: Emitter<IModelDecorationsChangedEvent> = this._register(new Emitter<IModelDecorationsChangedEvent>());
	public readonly event: Event<IModelDecorationsChangedEvent> = this._actual.event;

	private _deferredCnt: number;
	private _shouldFire: boolean;

	constructor() {
		super();
		this._deferredCnt = 0;
		this._shouldFire = false;
	}

	public beginDeferredEmit(): void {
		this._deferredCnt++;
	}

	public endDeferredEmit(): void {
		this._deferredCnt--;
		if (this._deferredCnt === 0) {
			if (this._shouldFire) {
				const event: IModelDecorationsChangedEvent = {};
				this._shouldFire = false;
				this._actual.fire(event);
			}
		}
	}

	public fire(): void {
		this._shouldFire = true;
	}
}

//#endregion

export class DidChangeContentEmitter extends Disposable {

	/**
	 * Both `fastEvent` and `slowEvent` work the same way and contain the same events, but first we invoke `fastEvent` and then `slowEvent`.
	 */
	private readonly _fastEmitter: Emitter<InternalModelContentChangeEvent> = this._register(new Emitter<InternalModelContentChangeEvent>());
	public readonly fastEvent: Event<InternalModelContentChangeEvent> = this._fastEmitter.event;
	private readonly _slowEmitter: Emitter<InternalModelContentChangeEvent> = this._register(new Emitter<InternalModelContentChangeEvent>());
	public readonly slowEvent: Event<InternalModelContentChangeEvent> = this._slowEmitter.event;

	private _deferredCnt: number;
	private _deferredEvent: InternalModelContentChangeEvent | null;

	constructor() {
		super();
		this._deferredCnt = 0;
		this._deferredEvent = null;
	}

	public beginDeferredEmit(): void {
		this._deferredCnt++;
	}

	public endDeferredEmit(resultingSelection: Selection[] | null = null): void {
		this._deferredCnt--;
		if (this._deferredCnt === 0) {
			if (this._deferredEvent !== null) {
				this._deferredEvent.rawContentChangedEvent.resultingSelection = resultingSelection;
				const e = this._deferredEvent;
				this._deferredEvent = null;
				this._fastEmitter.fire(e);
				this._slowEmitter.fire(e);
			}
		}
	}

	public fire(e: InternalModelContentChangeEvent): void {
		if (this._deferredCnt > 0) {
			if (this._deferredEvent) {
				this._deferredEvent = this._deferredEvent.merge(e);
			} else {
				this._deferredEvent = e;
			}
			return;
		}
		this._fastEmitter.fire(e);
		this._slowEmitter.fire(e);
	}
}
