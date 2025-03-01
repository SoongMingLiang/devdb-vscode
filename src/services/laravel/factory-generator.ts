import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { Column, DatabaseEngine } from '../../types';
import { getWorkspaceTables } from '../messenger';
import { getTable } from '../codelens/laravel/laravel-codelens-service';
import { ArtisanService } from './artisan-service';
import { showMissingDatabaseNotification } from '../error-notification-service';

export class LaravelFactoryGenerator {
    constructor(private database: DatabaseEngine | null) { }

    async generateFactory(modelName: string, modelFilePath: string): Promise<void> {
        if (!String(modelName).trim()) {
            vscode.window.showErrorMessage('Please provide a model name.');
            return
        }

        if (!isConnected(this.database)) {
            return showMissingDatabaseNotification();
        }

        const artisan = ArtisanService.create();
        if (!artisan) {
            return;
        }

        const factoryName = `${modelName}Factory`;
        const factoryFileName = `${factoryName}.php`;

        // Check if factory already exists
        const existingFactoryPath = await this.findFactoryFile(factoryFileName);
        if (existingFactoryPath) {
            const action = await vscode.window.showWarningMessage(
                `Factory ${factoryName} already exists`,
                { modal: false },
                { title: 'Open Existing', id: 'open' },
                { title: 'Overwrite', id: 'overwrite' }
            );

            if (action?.id === 'open') {
                const document = await vscode.workspace.openTextDocument(existingFactoryPath);
                await vscode.window.showTextDocument(document);
                return;
            }

            if (action?.id !== 'overwrite') {
                return;
            }
        }

        if (!await artisan.runCommand('make:factory', [`${factoryName}`])) {
            return;
        }

        const factoryPath = await this.findFactoryFile(factoryFileName);
        if (!factoryPath) {
            vscode.window.showErrorMessage(
                'Factory file not found after creation. Make sure your Laravel project structure is correct.'
            );
            return;
        }

        const tableNameForModel = await getTable(modelFilePath, modelName);
        if (!tableNameForModel) {
            vscode.window.showErrorMessage(`Could not determine table name for model ${modelName}`);
            return;
        }

        try {
            await this.updateFactoryContent(factoryPath, tableNameForModel);
            const action = await vscode.window.showInformationMessage(
                `Created factory ${factoryName}`,
                { modal: false },
                { title: 'Open Factory', id: 'open' }
            );

            if (action?.id === 'open') {
                const document = await vscode.workspace.openTextDocument(factoryPath);
                await vscode.window.showTextDocument(document);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update factory content: ${String(error)}`);
        }
    }

    private async findFactoryFile(fileName: string): Promise<string | undefined> {
        const files = await vscode.workspace.findFiles(
            '**/database/factories/' + fileName
        );
        return files[0]?.fsPath;
    }

    private async updateFactoryContent(
        factoryPath: string,
        tableName: string
    ): Promise<void> {
        // Read the factory file
        const content = await fs.readFile(factoryPath, 'utf8');

        // Get table columns
        const columns = await this.database!.getColumns(tableName);

        const definitions = this.generateColumnDefinitions(columns);

        // Replace the return array content
        const updatedContent = content.replace(
            /return \[([\s\S]*?)\];/,
            `return [\n${definitions}\n        ];`
        );

        // Write back to file
        await fs.writeFile(factoryPath, updatedContent, 'utf8');
    }

    private generateColumnDefinitions(columns: Column[]): string {
        return columns
            .map(column => {
                const fakerMethod = this.getFakerMethodForColumn(column);
                return `            '${column.name}' => ${fakerMethod},`;
            })
            .join('\n');
    }

    private getFakerMethodForColumn(column: Column): string {
        const type = column.type.toLowerCase();

        // Special column name handling first
        const columnName = column.name.toLowerCase();
        if (columnName.includes('email')) {
            return 'fake()->safeEmail()';
        }
        if (columnName.includes('name')) {
            return 'fake()->name()';
        }
        if (columnName.includes('phone')) {
            return 'fake()->phoneNumber()';
        }
        if (columnName.includes('address')) {
            return 'fake()->address()';
        }

        const typeMap: Record<string, string> = {
            'varchar': '$this->faker->text()',
            'char': '$this->faker->text()',
            'text': '$this->faker->paragraph()',
            'integer': '$this->faker->numberBetween(1, 1000)',
            'bigint': '$this->faker->numberBetween(1, 1000)',
            'boolean': '$this->faker->boolean()',
            'date': '$this->faker->date()',
            'datetime': '$this->faker->dateTime()',
            'timestamp': '$this->faker->dateTime()',
            'decimal': '$this->faker->randomFloat(2, 0, 1000)',
            'float': '$this->faker->randomFloat(2, 0, 1000)',
            'json': '$this->faker->json()',
            'uuid': '$this->faker->uuid()',
        };

        return typeMap[type] || 'fake()->text()';
    }
}

function isConnected(database: DatabaseEngine | null): boolean {
    const tables = getWorkspaceTables();
    if (!database || tables.length === 0) {
        vscode.window.showErrorMessage(
            'No database connection found. Please connect to a database before generating factory.',
            'Open DevDB'
        ).then(selection => {
            if (selection === 'Open DevDB') {
                vscode.commands.executeCommand('devdb.focus');
            }
        });
        return false;
    }

    return true
}
