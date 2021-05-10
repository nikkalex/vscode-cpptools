/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Original file: vscode/src/vs/editor/common/controller/cursor.ts

import { CursorCollection } from './cursorCollection';
import { CursorColumns, CursorConfiguration, CursorContext, CursorState, EditOperationType, IColumnSelectData, PartialCursorState, ICursorSimpleModel } from './cursorCommon';
import { CursorChangeReason } from './cursorEvents';
import { Position } from '../core/position';
import { Range } from '../core/range';
import { ISelection, Selection } from '../core/selection';
import * as editorCommon from '../editorCommon';
import { ITextModel, IIdentifiedSingleEditOperation } from '../model';
import { RawContentChangedType, ModelRawContentChangedEvent } from '../model/textModelEvents';
import { VerticalRevealType, ViewCursorStateChangedEvent, ViewRevealRangeRequestEvent } from '../view/viewEvents';
import { Disposable } from '../lifecycle';
import { ICoordinatesConverter } from '../viewModel/viewModel';
import { CursorStateChangedEvent, ViewModelEventsCollector } from '../viewModel/viewModelEventDispatcher';

/**
 * A snapshot of the cursor and the model state
 */
export class CursorModelState {

	public readonly cursorState: CursorState[];

	constructor(cursor: Cursor) {
		this.cursorState = cursor.getCursorStates();
	}

	public equals(other: CursorModelState | null): boolean {
		if (!other) {
			return false;
		}
		if (this.cursorState.length !== other.cursorState.length) {
			return false;
		}
		for (let i = 0, len = this.cursorState.length; i < len; i++) {
			if (!this.cursorState[i].equals(other.cursorState[i])) {
				return false;
			}
		}
		return true;
	}
}

export class Cursor extends Disposable {

	public static readonly MAX_CURSOR_COUNT = 10000;

	private readonly _model: ITextModel;
	private readonly _viewModel: ICursorSimpleModel;
	private readonly _coordinatesConverter: ICoordinatesConverter;
	public context: CursorContext;
	private _cursors: CursorCollection;

	private _hasFocus: boolean;
	private _isHandling: boolean;
	private _columnSelectData: IColumnSelectData | null;
	private _prevEditOperationType: EditOperationType;

	constructor(model: ITextModel, viewModel: ICursorSimpleModel, coordinatesConverter: ICoordinatesConverter, cursorConfig: CursorConfiguration) {
		super();
		this._model = model;
		this._viewModel = viewModel;
		this._coordinatesConverter = coordinatesConverter;
		this.context = new CursorContext(this._model, this._coordinatesConverter, cursorConfig);
		this._cursors = new CursorCollection(this.context);

		this._hasFocus = false;
		this._isHandling = false;
		this._columnSelectData = null;
		this._prevEditOperationType = EditOperationType.Other;
	}

	public override dispose(): void {
		this._cursors.dispose();
		super.dispose();
	}

	public updateConfiguration(cursorConfig: CursorConfiguration): void {
		this.context = new CursorContext(this._model, this._coordinatesConverter, cursorConfig);
		this._cursors.updateContext(this.context);
	}

	public onLineMappingChanged(eventsCollector: ViewModelEventsCollector): void {
		// Ensure valid state
		this.setStates(eventsCollector, 'viewModel', CursorChangeReason.NotSet, this.getCursorStates());
	}

	public setHasFocus(hasFocus: boolean): void {
		this._hasFocus = hasFocus;
	}

	// ------ some getters/setters

	public getPrimaryCursorState(): CursorState {
		return this._cursors.getPrimaryCursor();
	}

	public getLastAddedCursorIndex(): number {
		return this._cursors.getLastAddedCursorIndex();
	}

	public getCursorStates(): CursorState[] {
		return this._cursors.getAll();
	}

	public setStates(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, reason: CursorChangeReason, states: PartialCursorState[] | null): boolean {
		let reachedMaxCursorCount = false;
		if (states !== null && states.length > Cursor.MAX_CURSOR_COUNT) {
			states = states.slice(0, Cursor.MAX_CURSOR_COUNT);
			reachedMaxCursorCount = true;
		}

		const oldState = new CursorModelState(this);

		this._cursors.setStates(states);
		this._cursors.normalize();
		this._columnSelectData = null;

		return this._emitStateChangedIfNecessary(eventsCollector, source, reason, oldState, reachedMaxCursorCount);
	}

	public setCursorColumnSelectData(columnSelectData: IColumnSelectData): void {
		this._columnSelectData = columnSelectData;
	}

	public revealPrimary(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, revealHorizontal: boolean, scrollType: editorCommon.ScrollType): void {
		const viewPositions = this._cursors.getViewPositions();
		if (viewPositions.length > 1) {
			this._emitCursorRevealRange(eventsCollector, source, null, this._cursors.getViewSelections(), VerticalRevealType.Simple, revealHorizontal, scrollType);
			return;
		} else {
			const viewPosition = viewPositions[0];
			const viewRange = new Range(viewPosition.lineNumber, viewPosition.column, viewPosition.lineNumber, viewPosition.column);
			this._emitCursorRevealRange(eventsCollector, source, viewRange, null, VerticalRevealType.Simple, revealHorizontal, scrollType);
		}
	}

	private _revealPrimaryCursor(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, verticalType: VerticalRevealType, revealHorizontal: boolean, scrollType: editorCommon.ScrollType): void {
		const viewPositions = this._cursors.getViewPositions();
		if (viewPositions.length > 1) {
			this._emitCursorRevealRange(eventsCollector, source, null, this._cursors.getViewSelections(), verticalType, revealHorizontal, scrollType);
		} else {
			const viewPosition = viewPositions[0];
			const viewRange = new Range(viewPosition.lineNumber, viewPosition.column, viewPosition.lineNumber, viewPosition.column);
			this._emitCursorRevealRange(eventsCollector, source, viewRange, null, verticalType, revealHorizontal, scrollType);
		}
	}

	private _emitCursorRevealRange(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, viewRange: Range | null, viewSelections: Selection[] | null, verticalType: VerticalRevealType, revealHorizontal: boolean, scrollType: editorCommon.ScrollType) {
		eventsCollector.emitViewEvent(new ViewRevealRangeRequestEvent(source, viewRange, viewSelections, verticalType, revealHorizontal, scrollType));
	}

	public saveState(): editorCommon.ICursorState[] {

		let result: editorCommon.ICursorState[] = [];

		const selections = this._cursors.getSelections();
		for (let i = 0, len = selections.length; i < len; i++) {
			const selection = selections[i];

			result.push({
				inSelectionMode: !selection.isEmpty(),
				selectionStart: {
					lineNumber: selection.selectionStartLineNumber,
					column: selection.selectionStartColumn,
				},
				position: {
					lineNumber: selection.positionLineNumber,
					column: selection.positionColumn,
				}
			});
		}

		return result;
	}

	public restoreState(eventsCollector: ViewModelEventsCollector, states: editorCommon.ICursorState[]): void {

		let desiredSelections: ISelection[] = [];

		for (let i = 0, len = states.length; i < len; i++) {
			const state = states[i];

			let positionLineNumber = 1;
			let positionColumn = 1;

			// Avoid missing properties on the literal
			if (state.position && state.position.lineNumber) {
				positionLineNumber = state.position.lineNumber;
			}
			if (state.position && state.position.column) {
				positionColumn = state.position.column;
			}

			let selectionStartLineNumber = positionLineNumber;
			let selectionStartColumn = positionColumn;

			// Avoid missing properties on the literal
			if (state.selectionStart && state.selectionStart.lineNumber) {
				selectionStartLineNumber = state.selectionStart.lineNumber;
			}
			if (state.selectionStart && state.selectionStart.column) {
				selectionStartColumn = state.selectionStart.column;
			}

			desiredSelections.push({
				selectionStartLineNumber: selectionStartLineNumber,
				selectionStartColumn: selectionStartColumn,
				positionLineNumber: positionLineNumber,
				positionColumn: positionColumn
			});
		}

		this.setStates(eventsCollector, 'restoreState', CursorChangeReason.NotSet, CursorState.fromModelSelections(desiredSelections));
		this.revealPrimary(eventsCollector, 'restoreState', true, editorCommon.ScrollType.Immediate);
	}

	public onModelContentChanged(eventsCollector: ViewModelEventsCollector, e: ModelRawContentChangedEvent): void {

		if (this._isHandling) {
			return;
		}

		const hadFlushEvent = e.containsEvent(RawContentChangedType.Flush);
		this._prevEditOperationType = EditOperationType.Other;

		if (hadFlushEvent) {
			// a model.setValue() was called
			this._cursors.dispose();
			this._cursors = new CursorCollection(this.context);
			this._emitStateChangedIfNecessary(eventsCollector, 'model', CursorChangeReason.ContentFlush, null, false);
		} else {
			if (this._hasFocus && e.resultingSelection && e.resultingSelection.length > 0) {
				const cursorState = CursorState.fromModelSelections(e.resultingSelection);
				if (this.setStates(eventsCollector, 'modelChange', e.isUndoing ? CursorChangeReason.Undo : e.isRedoing ? CursorChangeReason.Redo : CursorChangeReason.RecoverFromMarkers, cursorState)) {
					this._revealPrimaryCursor(eventsCollector, 'modelChange', VerticalRevealType.Simple, true, editorCommon.ScrollType.Smooth);
				}
			} else {
				const selectionsFromMarkers = this._cursors.readSelectionFromMarkers();
				this.setStates(eventsCollector, 'modelChange', CursorChangeReason.RecoverFromMarkers, CursorState.fromModelSelections(selectionsFromMarkers));
			}
		}
	}

	public getSelection(): Selection {
		return this._cursors.getPrimaryCursor().modelState.selection;
	}

	public getTopMostViewPosition(): Position {
		return this._cursors.getTopMostViewPosition();
	}

	public getBottomMostViewPosition(): Position {
		return this._cursors.getBottomMostViewPosition();
	}

	public getCursorColumnSelectData(): IColumnSelectData {
		if (this._columnSelectData) {
			return this._columnSelectData;
		}
		const primaryCursor = this._cursors.getPrimaryCursor();
		const viewSelectionStart = primaryCursor.viewState.selectionStart.getStartPosition();
		const viewPosition = primaryCursor.viewState.position;
		return {
			isReal: false,
			fromViewLineNumber: viewSelectionStart.lineNumber,
			fromViewVisualColumn: CursorColumns.visibleColumnFromColumn2(this.context.cursorConfig, this._viewModel, viewSelectionStart),
			toViewLineNumber: viewPosition.lineNumber,
			toViewVisualColumn: CursorColumns.visibleColumnFromColumn2(this.context.cursorConfig, this._viewModel, viewPosition),
		};
	}

	public getSelections(): Selection[] {
		return this._cursors.getSelections();
	}

	public getPosition(): Position {
		return this._cursors.getPrimaryCursor().modelState.position;
	}

	public setSelections(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, selections: readonly ISelection[], reason: CursorChangeReason): void {
		this.setStates(eventsCollector, source, reason, CursorState.fromModelSelections(selections));
	}

	public getPrevEditOperationType(): EditOperationType {
		return this._prevEditOperationType;
	}

	public setPrevEditOperationType(type: EditOperationType): void {
		this._prevEditOperationType = type;
	}

	// ----- emitting events

	private _emitStateChangedIfNecessary(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, reason: CursorChangeReason, oldState: CursorModelState | null, reachedMaxCursorCount: boolean): boolean {
		const newState = new CursorModelState(this);
		if (newState.equals(oldState)) {
			return false;
		}

		const selections = this._cursors.getSelections();
		const viewSelections = this._cursors.getViewSelections();

		// Let the view get the event first.
		eventsCollector.emitViewEvent(new ViewCursorStateChangedEvent(viewSelections, selections));

		// Only after the view has been notified, let the rest of the world know...
		if (!oldState
			|| oldState.cursorState.length !== newState.cursorState.length
			|| newState.cursorState.some((newCursorState, i) => !newCursorState.modelState.equals(oldState.cursorState[i].modelState))
		) {
			const oldSelections = oldState ? oldState.cursorState.map(s => s.modelState.selection) : null;
			eventsCollector.emitOutgoingEvent(new CursorStateChangedEvent(oldSelections, selections, source || 'keyboard', reason, reachedMaxCursorCount));
		}

		return true;
	}

	// -----------------------------------------------------------------------------------------------------------
	// ----- handlers beyond this point

	public executeEdits(edits: IIdentifiedSingleEditOperation[]): void {
		this._model.applyEdits(edits);
	}
}
