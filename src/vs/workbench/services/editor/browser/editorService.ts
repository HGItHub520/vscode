/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import URI from 'vs/base/common/uri';
import network = require('vs/base/common/network');
import { Registry } from 'vs/platform/registry/common/platform';
import { basename, dirname } from 'vs/base/common/paths';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { EditorInput, EditorOptions, TextEditorOptions, IEditorRegistry, Extensions, SideBySideEditorInput, IFileEditorInput, IFileInputFactory } from 'vs/workbench/common/editor';
import { ResourceEditorInput } from 'vs/workbench/common/editor/resourceEditorInput';
import { IUntitledEditorService, UNTITLED_SCHEMA } from 'vs/workbench/services/untitled/common/untitledEditorService';
import { IWorkbenchEditorService, IResourceInputType } from 'vs/workbench/services/editor/common/editorService';
import { IEditorInput, IEditorOptions, ITextEditorOptions, Position, Direction, IEditor, IResourceInput, IResourceDiffInput, IResourceSideBySideInput, IUntitledResourceInput } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import nls = require('vs/nls');
import { getPathLabel } from 'vs/base/common/labels';
import { ResourceMap } from 'vs/base/common/map';
import { once } from 'vs/base/common/event';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IFileService } from 'vs/platform/files/common/files';

export interface IEditorPart {
	openEditor(input?: IEditorInput, options?: IEditorOptions | ITextEditorOptions, sideBySide?: boolean): TPromise<BaseEditor>;
	openEditor(input?: IEditorInput, options?: IEditorOptions | ITextEditorOptions, position?: Position): TPromise<BaseEditor>;
	openEditors(editors: { input: IEditorInput, position: Position, options?: IEditorOptions | ITextEditorOptions }[]): TPromise<BaseEditor[]>;
	replaceEditors(editors: { toReplace: IEditorInput, replaceWith: IEditorInput, options?: IEditorOptions | ITextEditorOptions }[], position?: Position): TPromise<BaseEditor[]>;
	closeEditor(position: Position, input: IEditorInput): TPromise<void>;
	closeEditors(position: Position, filter?: { except?: IEditorInput, direction?: Direction, unmodifiedOnly?: boolean }): TPromise<void>;
	closeAllEditors(except?: Position): TPromise<void>;
	getActiveEditor(): BaseEditor;
	getVisibleEditors(): IEditor[];
	getActiveEditorInput(): IEditorInput;
}

type ICachedEditorInput = ResourceEditorInput | IFileEditorInput;

export class WorkbenchEditorService implements IWorkbenchEditorService {

	public _serviceBrand: any;

	private static CACHE: ResourceMap<ICachedEditorInput> = new ResourceMap<ICachedEditorInput>();

	private editorPart: IEditorPart | IWorkbenchEditorService;
	private fileInputFactory: IFileInputFactory;

	constructor(
		editorPart: IEditorPart | IWorkbenchEditorService,
		@IUntitledEditorService private untitledEditorService: IUntitledEditorService,
		@IWorkspaceContextService private workspaceContextService: IWorkspaceContextService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IFileService private fileService: IFileService
	) {
		this.editorPart = editorPart;
		this.fileInputFactory = Registry.as<IEditorRegistry>(Extensions.Editors).getFileInputFactory();
	}

	public getActiveEditor(): IEditor {
		return this.editorPart.getActiveEditor();
	}

	public getActiveEditorInput(): IEditorInput {
		return this.editorPart.getActiveEditorInput();
	}

	public getVisibleEditors(): IEditor[] {
		return this.editorPart.getVisibleEditors();
	}

	public isVisible(input: IEditorInput, includeSideBySide: boolean): boolean {
		if (!input) {
			return false;
		}

		return this.getVisibleEditors().some(editor => {
			if (!editor.input) {
				return false;
			}

			if (input.matches(editor.input)) {
				return true;
			}

			if (includeSideBySide && editor.input instanceof SideBySideEditorInput) {
				const sideBySideInput = <SideBySideEditorInput>editor.input;
				return input.matches(sideBySideInput.master) || input.matches(sideBySideInput.details);
			}

			return false;
		});
	}

	public openEditor(input: IEditorInput, options?: IEditorOptions, sideBySide?: boolean): TPromise<IEditor>;
	public openEditor(input: IEditorInput, options?: IEditorOptions, position?: Position): TPromise<IEditor>;
	public openEditor(input: IResourceInputType, position?: Position): TPromise<IEditor>;
	public openEditor(input: IResourceInputType, sideBySide?: boolean): TPromise<IEditor>;
	public openEditor(input: any, arg2?: any, arg3?: any): TPromise<IEditor> {
		if (!input) {
			return TPromise.as<IEditor>(null);
		}

		// Workbench Input Support
		if (input instanceof EditorInput) {
			return this.doOpenEditor(input, this.toOptions(arg2), arg3);
		}

		// Support opening foreign resources (such as a http link that points outside of the workbench)
		const resourceInput = <IResourceInput>input;
		if (resourceInput.resource instanceof URI) {
			const schema = resourceInput.resource.scheme;
			if (schema === network.Schemas.http || schema === network.Schemas.https) {
				window.open(resourceInput.resource.toString(true));

				return TPromise.as<IEditor>(null);
			}
		}

		// Untyped Text Editor Support (required for code that uses this service below workbench level)
		const textInput = <IResourceInputType>input;
		const typedInput = this.createInput(textInput);
		if (typedInput) {
			return this.doOpenEditor(typedInput, TextEditorOptions.from(textInput), arg2);
		}

		return TPromise.as<IEditor>(null);
	}

	private toOptions(options?: IEditorOptions | EditorOptions): EditorOptions {
		if (!options || options instanceof EditorOptions) {
			return options as EditorOptions;
		}

		const textOptions: ITextEditorOptions = options;
		if (!!textOptions.selection) {
			return TextEditorOptions.create(options);
		}

		return EditorOptions.create(options);
	}

	/**
	 * Allow subclasses to implement their own behavior for opening editor (see below).
	 */
	protected doOpenEditor(input: IEditorInput, options?: EditorOptions, sideBySide?: boolean): TPromise<IEditor>;
	protected doOpenEditor(input: IEditorInput, options?: EditorOptions, position?: Position): TPromise<IEditor>;
	protected doOpenEditor(input: IEditorInput, options?: EditorOptions, arg3?: any): TPromise<IEditor> {
		return this.editorPart.openEditor(input, options, arg3);
	}

	public openEditors(editors: { input: IResourceInputType, position: Position }[]): TPromise<IEditor[]>;
	public openEditors(editors: { input: IEditorInput, position: Position, options?: IEditorOptions }[]): TPromise<IEditor[]>;
	public openEditors(editors: any[]): TPromise<IEditor[]> {
		const inputs = editors.map(editor => this.createInput(editor.input));
		const typedInputs: { input: IEditorInput, position: Position, options?: EditorOptions }[] = inputs.map((input, index) => {
			const options = editors[index].input instanceof EditorInput ? this.toOptions(editors[index].options) : TextEditorOptions.from(editors[index].input);

			return {
				input,
				options,
				position: editors[index].position
			};
		});

		return this.editorPart.openEditors(typedInputs);
	}

	public replaceEditors(editors: { toReplace: IResourceInputType, replaceWith: IResourceInputType }[], position?: Position): TPromise<IEditor[]>;
	public replaceEditors(editors: { toReplace: IEditorInput, replaceWith: IEditorInput, options?: IEditorOptions }[], position?: Position): TPromise<IEditor[]>;
	public replaceEditors(editors: any[], position?: Position): TPromise<IEditor[]> {
		const toReplaceInputs = editors.map(editor => this.createInput(editor.toReplace));
		const replaceWithInputs = editors.map(editor => this.createInput(editor.replaceWith));
		const typedReplacements: { toReplace: IEditorInput, replaceWith: IEditorInput, options?: EditorOptions }[] = editors.map((editor, index) => {
			const options = editor.toReplace instanceof EditorInput ? this.toOptions(editor.options) : TextEditorOptions.from(editor.replaceWith);

			return {
				toReplace: toReplaceInputs[index],
				replaceWith: replaceWithInputs[index],
				options
			};
		});

		return this.editorPart.replaceEditors(typedReplacements, position);
	}

	public closeEditor(position: Position, input: IEditorInput): TPromise<void> {
		return this.doCloseEditor(position, input);
	}

	protected doCloseEditor(position: Position, input: IEditorInput): TPromise<void> {
		return this.editorPart.closeEditor(position, input);
	}

	public closeEditors(position: Position, filter?: { except?: IEditorInput, direction?: Direction, unmodifiedOnly?: boolean }): TPromise<void> {
		return this.editorPart.closeEditors(position, filter);
	}

	public closeAllEditors(except?: Position): TPromise<void> {
		return this.editorPart.closeAllEditors(except);
	}

	public createInput(input: IEditorInput): EditorInput;
	public createInput(input: IResourceInputType): EditorInput;
	public createInput(input: any): IEditorInput {

		// Workbench Input Support
		if (input instanceof EditorInput) {
			return input;
		}

		// Side by Side Support
		const resourceSideBySideInput = <IResourceSideBySideInput>input;
		if (resourceSideBySideInput.masterResource && resourceSideBySideInput.detailResource) {
			const masterInput = this.createInput({ resource: resourceSideBySideInput.masterResource });
			const detailInput = this.createInput({ resource: resourceSideBySideInput.detailResource });

			return new SideBySideEditorInput(resourceSideBySideInput.label || masterInput.getName(), typeof resourceSideBySideInput.description === 'string' ? resourceSideBySideInput.description : masterInput.getDescription(), detailInput, masterInput);
		}

		// Diff Editor Support
		const resourceDiffInput = <IResourceDiffInput>input;
		if (resourceDiffInput.leftResource && resourceDiffInput.rightResource) {
			const leftInput = this.createInput({ resource: resourceDiffInput.leftResource });
			const rightInput = this.createInput({ resource: resourceDiffInput.rightResource });
			const label = resourceDiffInput.label || this.toDiffLabel(resourceDiffInput.leftResource, resourceDiffInput.rightResource, this.workspaceContextService, this.environmentService);

			return new DiffEditorInput(label, resourceDiffInput.description, leftInput, rightInput);
		}

		// Untitled file support
		const untitledInput = <IUntitledResourceInput>input;
		if (!untitledInput.resource || typeof untitledInput.filePath === 'string' || (untitledInput.resource instanceof URI && untitledInput.resource.scheme === UNTITLED_SCHEMA)) {
			return this.untitledEditorService.createOrGet(untitledInput.filePath ? URI.file(untitledInput.filePath) : untitledInput.resource, untitledInput.language, untitledInput.contents, untitledInput.encoding);
		}

		const resourceInput = <IResourceInput>input;

		// Files support
		if (resourceInput.resource instanceof URI && resourceInput.resource.scheme === network.Schemas.file) {
			return this.createOrGet(resourceInput.resource, this.instantiationService, resourceInput.label, resourceInput.description, resourceInput.encoding);
		}

		// Any other resource
		else if (resourceInput.resource instanceof URI) {
			const label = resourceInput.label || basename(resourceInput.resource.fsPath);
			let description: string;
			if (typeof resourceInput.description === 'string') {
				description = resourceInput.description;
			} else if (resourceInput.resource.scheme === network.Schemas.file) {
				description = dirname(resourceInput.resource.fsPath);
			}

			return this.createOrGet(resourceInput.resource, this.instantiationService, label, description);
		}

		return null;
	}

	private createOrGet(resource: URI, instantiationService: IInstantiationService, label: string, description: string, encoding?: string): ICachedEditorInput {
		if (WorkbenchEditorService.CACHE.has(resource)) {
			const input = WorkbenchEditorService.CACHE.get(resource);
			if (input instanceof ResourceEditorInput) {
				input.setName(label);
				input.setDescription(description);
			} else {
				input.setPreferredEncoding(encoding);
			}

			return input;
		}

		let input: ICachedEditorInput;
		if (resource.scheme === network.Schemas.file || this.fileService.canHandleResource && this.fileService.canHandleResource(resource)) {
			input = this.fileInputFactory.createFileInput(resource, encoding, instantiationService);
		} else {
			input = instantiationService.createInstance(ResourceEditorInput, label, description, resource);
		}

		WorkbenchEditorService.CACHE.set(resource, input);
		once(input.onDispose)(() => {
			WorkbenchEditorService.CACHE.delete(resource);
		});

		return input;
	}

	private toDiffLabel(res1: URI, res2: URI, context: IWorkspaceContextService, environment: IEnvironmentService): string {
		const leftName = getPathLabel(res1.fsPath, context, environment);
		const rightName = getPathLabel(res2.fsPath, context, environment);

		return nls.localize('compareLabels', "{0} ↔ {1}", leftName, rightName);
	}
}

export interface IEditorOpenHandler {
	(input: IEditorInput, options?: EditorOptions, sideBySide?: boolean): TPromise<BaseEditor>;
	(input: IEditorInput, options?: EditorOptions, position?: Position): TPromise<BaseEditor>;
}

export interface IEditorCloseHandler {
	(position: Position, input: IEditorInput): TPromise<void>;
}

/**
 * Subclass of workbench editor service that delegates all calls to the provided editor service. Subclasses can choose to override the behavior
 * of openEditor() and closeEditor() by providing a handler.
 *
 * This gives clients a chance to override the behavior of openEditor() and closeEditor().
 */
export class DelegatingWorkbenchEditorService extends WorkbenchEditorService {
	private editorOpenHandler: IEditorOpenHandler;
	private editorCloseHandler: IEditorCloseHandler;

	constructor(
		@IUntitledEditorService untitledEditorService: IUntitledEditorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService fileService: IFileService
	) {
		super(
			editorService,
			untitledEditorService,
			workspaceContextService,
			instantiationService,
			environmentService,
			fileService
		);
	}

	public setEditorOpenHandler(handler: IEditorOpenHandler): void {
		this.editorOpenHandler = handler;
	}

	public setEditorCloseHandler(handler: IEditorCloseHandler): void {
		this.editorCloseHandler = handler;
	}

	protected doOpenEditor(input: IEditorInput, options?: EditorOptions, sideBySide?: boolean): TPromise<IEditor>;
	protected doOpenEditor(input: IEditorInput, options?: EditorOptions, position?: Position): TPromise<IEditor>;
	protected doOpenEditor(input: IEditorInput, options?: EditorOptions, arg3?: any): TPromise<IEditor> {
		const handleOpen = this.editorOpenHandler ? this.editorOpenHandler(input, options, arg3) : TPromise.as(void 0);

		return handleOpen.then(editor => {
			if (editor) {
				return TPromise.as<BaseEditor>(editor);
			}

			return super.doOpenEditor(input, options, arg3);
		});
	}

	protected doCloseEditor(position: Position, input: IEditorInput): TPromise<void> {
		const handleClose = this.editorCloseHandler ? this.editorCloseHandler(position, input) : TPromise.as(void 0);

		return handleClose.then(() => {
			return super.doCloseEditor(position, input);
		});
	}
}
