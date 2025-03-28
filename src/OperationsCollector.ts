import {OpenAPIVisitor, OperationContext} from "./openapi/OpenAPIVisitor";
import * as lodash from "lodash";
import pino from "pino";
import {OpenAPIV3} from "openapi-types";
import {N8NINodeProperties} from "./n8n/SchemaToINodeProperties";
import {IOperationParser} from "./OperationParser";
import {OptionsByResourceMap} from "./n8n/OptionsByResourceMap";
import {INodeProperties} from "n8n-workflow";
import {replacePathVarsToParameter} from "./n8n/utils";
import {IResourceParser} from "./ResourceParser";

export class BaseOperationsCollector implements OpenAPIVisitor {
    public readonly _fields: INodeProperties[]
    private optionsByResource: OptionsByResourceMap = new OptionsByResourceMap()
    private n8nNodeProperties: N8NINodeProperties;

    // Log context
    private bindings: any

    constructor(
        doc: any,
        protected operationParser: IOperationParser,
        protected resourceParser: IResourceParser,
        protected logger: pino.Logger
    ) {
        this._fields = []
        this.n8nNodeProperties = new N8NINodeProperties(doc)
    }

    get operations(): INodeProperties[] {
        if (this.optionsByResource.size === 0) {
            throw new Error('No operations found in OpenAPI document')
        }

        const operations = []
        for (const [resource, options] of this.optionsByResource) {
            const operation: INodeProperties = {
                displayName: 'Operation',
                name: 'operation',
                type: 'options',
                noDataExpression: true,
                displayOptions: {
                    show: {
                        resource: [resource],
                    },
                },
                options: options,
                default: '',
            };
            operations.push(operation);
        }
        return operations
    }

    get fields() {
        return [...this._fields]
    }

    visitOperation(operation: OpenAPIV3.OperationObject, context: OperationContext) {
        const bindings = {
            operation: {
                pattern: context.pattern,
                method: context.method,
                operationId: operation.operationId
            }
        }
        this.bindings = bindings
        try {
            this._visitOperation(operation, context)
        } catch (error) {
            // @ts-ignore
            const data = {...this.bindings, error: `${error}`}
            // @ts-ignore
            this.logger.warn(data, 'Failed to parse operation')
        }
    }

    _visitOperation(operation: OpenAPIV3.OperationObject, context: OperationContext) {
        if (this.operationParser.shouldSkip(operation, context)) {
            this.logger.info(this.bindings, 'Skipping operation')
            return
        }
        const {option, fields: operationFields} = this.parseOperation(operation, context);
        const resources = operation.tags!!.map((tag: string) => this.resourceParser.value({name: tag}))
        for (const resourceName of resources) {
            const fields = lodash.cloneDeep(operationFields)
            const operationName = option.name;
            this.addDisplayOption(fields, resourceName, operationName)
            this.optionsByResource.add(resourceName, option);
            this._fields.push(...fields)
        }
    }

    /**
     * Parse fields from operation, both parameters and request body
     * Separates required and optional fields
     */
    parseFields(operation: OpenAPIV3.OperationObject, context: OperationContext) {
        const fields = [];
        
        // Handle parameters
        if (operation.parameters) {
            const requiredParameters: INodeProperties[] = [];
            const optionalParameters: INodeProperties[] = [];
            
            // Get all parameters
            const allParameters = this.n8nNodeProperties.fromParameters(operation.parameters);
            
            // Split into required and optional
            for (const param of allParameters) {
                if (param.required) {
                    requiredParameters.push(param);
                } else {
                    optionalParameters.push(param);
                }
            }
            
            // Add required parameters directly
            fields.push(...requiredParameters);
            
            // Add optional parameters in a collection field
            if (optionalParameters.length > 0) {
                const additionalFieldsOption: INodeProperties = {
                    displayName: 'Additional Query Parameters',
                    name: 'additionalQueryParameters',
                    type: 'collection',
                    placeholder: 'Add Field',
                    default: {},
                    options: optionalParameters,
                    description: 'Optional query parameters that can be added',
                };
                
                fields.push(additionalFieldsOption);
            }
        }

        // Handle request body
        try {
            const bodyFields = this.n8nNodeProperties.fromRequestBody(operation.requestBody);
            
            if (bodyFields.length > 0) {
                const requiredBodyFields: INodeProperties[] = [];
                const optionalBodyFields: INodeProperties[] = [];
                
                // Split body fields into required and optional
                for (const field of bodyFields) {
                    if (field.required) {
                        requiredBodyFields.push(field);
                    } else {
                        optionalBodyFields.push(field);
                    }
                }
                
                // Add required body fields directly
                fields.push(...requiredBodyFields);
                
                // Add optional body fields in a collection field
                if (optionalBodyFields.length > 0) {
                    const additionalBodyFieldsOption: INodeProperties = {
                        displayName: 'Additional Body Fields',
                        name: 'additionalBodyFields',
                        type: 'collection',
                        placeholder: 'Add Field',
                        default: {},
                        options: optionalBodyFields,
                        description: 'Optional body fields that can be added',
                    };
                    
                    fields.push(additionalBodyFieldsOption);
                }
            }
        } catch (error) {
            const data = {...this.bindings, error: `${error}`}
            // @ts-ignore
            this.logger.warn(data, 'Failed to parse request body')
            const msg = "There's no body available for request, kindly use HTTP Request node to send body"
            const notice: INodeProperties = {
                displayName: `${context.method.toUpperCase()} ${context.pattern}<br/><br/>${msg}`,
                name: 'operation',
                type: 'notice',
                default: '',
            }
            fields.push(notice)
        }
        
        return fields;
    }

    private addDisplayOption(fields: INodeProperties[], resource: string, operation: string) {
        const displayOptions = {
            show: {
                resource: [resource],
                operation: [operation],
            },
        }
        fields.forEach((field) => {
            field.displayOptions = displayOptions
        })
    }

    protected parseOperation(operation: OpenAPIV3.OperationObject, context: OperationContext) {
        const method = context.method
        const uri = context.pattern;
        const parser = this.operationParser
        const option = {
            name: parser.name(operation, context),
            value: parser.value(operation, context),
            action: parser.action(operation, context),
            description: parser.description(operation, context),
            routing: {
                request: {
                    method: method.toUpperCase(),
                    url: `=${replacePathVarsToParameter(uri)}`,
                },
            },
        };
        const fields = this.parseFields(operation, context);


        return {
            option: option,
            fields: fields,
        };
    }
}

export class OperationsCollector extends BaseOperationsCollector {
    protected parseOperation(operation: OpenAPIV3.OperationObject, context: OperationContext) {
        const result = super.parseOperation(operation, context)
        const notice: INodeProperties = {
            displayName: `${context.method.toUpperCase()} ${context.pattern}`,
            name: 'operation',
            type: 'notice',
            typeOptions: {
                theme: 'info',
            },
            default: '',
        };
        result.fields.unshift(notice);
        return result
    }
}

