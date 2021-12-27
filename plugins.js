import { default as semver } from 'semver';
import * as util from 'util';
import { strict as assert } from 'assert';
import * as path from 'path';
import { readdir, readFile, access } from 'fs/promises';
import fetchStats, { filter as filterStats } from '../../npm-version-download-stats/src/index.js';
import { sumDownloads } from '../../npm-version-download-stats/src/utils.js';
import yaml from 'js-yaml';

const SUPPORTED_VERSIONS = Symbol('SUPPORTED_VERSIONS');
const INSTRUMENTED_PACKAGE_NAME = Symbol('INSTRUMENTED_PACKAGE_NAME');
const FETCH_STATS = Symbol('FETCH_STATS');
const TESTED_VERSION = Symbol('TESTED_VERSION');
const should = (pkgName, key) => {
	if (key === SUPPORTED_VERSIONS) {
		if (~[
				'@opentelemetry/instrumentation-aws-lambda',
				'@opentelemetry/instrumentation-aws-sdk', // TODO: supported version defined in .tav.yml
				'@opentelemetry/instrumentation-bunyan', // TODO: should get a supported version
				'@opentelemetry/instrumentation-dns',
				'@opentelemetry/instrumentation-net',
			].indexOf(pkgName)) {
			console.error('Ignoring', key, 'for', pkgName);
			return false;
		}
		return true;
	}
	if (key === INSTRUMENTED_PACKAGE_NAME) {
		if (pkgName === '@opentelemetry/instrumentation-aws-lambda') {
			console.error('Ignoring', key, 'for', pkgName);
			return false;
		}
		return true;
	}
	if (key === FETCH_STATS) {
		if (~[
				// '@opentelemetry/instrumentation-aws-sdk', // TODO: supported version defined in .tav.yml
				// '@opentelemetry/instrumentation-bunyan', // TODO: no supported version
				// '@opentelemetry/instrumentation-dns',
				// '@opentelemetry/instrumentation-net',
			].indexOf(pkgName)) {
			console.error('Ignoring', key, 'for', pkgName);
			return false;
		}
		return true;
	}
	assert.fail(`Invalid key: ${util.inspect(key)}`);
};

const getSupportedVersionSection = (readmeContents) => {
	// TODO: fix all those special cases
	const isHapi = /@hapi\/hapi `\^17.0.0`/.test(readmeContents);
	if (isHapi) {
		return '^17.0.0';
	}
	const isKoa = /Koa `\^2.0.0`/.test(readmeContents);
	if (isKoa) {
		return '^2.0.0';
	}
	const isMongo = /- `'>=3.3 <4`/.test(readmeContents);
	if (isMongo) {
		return '>=3.3 <4';
	}
	const isPg = /pg\): `7\.x`, `8\.\*`/.test(readmeContents);
	if (isPg) {
		return '7 || 8';
	}
	const isWinston = /`1\.x`, `2\.x`, `3\.x`/.test(readmeContents);
	if (isWinston) {
		return '>=1 <4';
	}
	const isOldGraphQL = /Minimum required graphql version is `v14`/.test(readmeContents);
	if (isOldGraphQL) {
		return '>=14';
	}
	const match = readmeContents.match(/#+ Supported Versions\n([^#]+)/i);
	assert(match && match[1], 'Could not find supported versions section:\n' + readmeContents);
	return match[1];
};
const getSupportedVersions = (readmeContents) => {
	const toBeTrimmed = '[-\\s`]+';
	const version = getSupportedVersionSection(readmeContents)
		?.replace(new RegExp('^' + toBeTrimmed, 'g'), '')
		?.replace(new RegExp(toBeTrimmed + '$', 'g'), '');
	assert(semver.validRange(version), `Invalid version ${util.inspect(version)} in section:\n${getSupportedVersionSection(readmeContents)}`);
	return version;
};
const parsePackageFromInstrumentationName = (instrumentationName) => {
	const packagePart = instrumentationName.match(/@opentelemetry\/instrumentation-(.*)$/)?.[1];
	// console.log('packagePart', packagePart);
	if (packagePart === 'nestjs-core') {
		return '@nestjs/core';
	}
	if (packagePart === 'hapi') {
		return '@hapi/hapi';
	}
	if (!/-/.test(packagePart)) {
		return packagePart;
	}
	console.error(`No naive name for ${instrumentationName}`);
	return null;
};
const parsePackageFromReadmeContents = (readmeContents) => {
	const thisModuleProvides = readmeContents.match(/This module provides.*/i)?.[0];
	// console.log('thisModuleProvides', thisModuleProvides);
	const match = readmeContents.match(/This module provides(?: basic)? automatic instrumentation [\sa-z]+ \[`([^\]`]+)/i)?.[1];
	assert(match, 'Could not find instrumented package name:\n' + readmeContents);
	if (!/\s/.test(match)) {
		return match
	}
	console.error(`No readme name for ${util.inspect(thisModuleProvides)}`);
	return null;
};
const getInstrumentedPackageName = (instrumentationName, readmeContents) => {
	const naiveName = parsePackageFromInstrumentationName(instrumentationName);
	// console.log('naiveName', naiveName);
	if (naiveName) {
		return naiveName;
	}
	const readmeName = parsePackageFromReadmeContents(readmeContents);
	if (readmeName) {
		return readmeName;
	}
	assert.fail(`Unable to parse package name for ${util.inspect(instrumentationName)}`);
};
const fileExists = (filePath) => {
	return access(filePath)
		.then((res) => { return true; })
		.catch((err) => {
			assert.equal(err.code, 'ENOENT', err);
			return false;
		});
};
const checkTav = async (root, packageJson) => {
	const config = await readFile(path.join(root, '.tav.yml'))
		.then((content) => yaml.load(content))
		.catch((err) => {
			assert.equal(err.code, 'ENOENT', err);
			return null;
		});
	const tavVersion = packageJson?.devDependencies['test-all-versions'];
	const script = packageJson?.scripts['test-all-versions'];

	return {
		valid: !!(config && tavVersion && script),
		config,
		tavVersion,
		script,
	};
};
const getTestedVersionsFromTavConfig = (packageName, config) => {
	assert.equal(typeof config, 'object');
	assert.equal(typeof packageName, 'string');
	const { [packageName]: packageConfig } = config;
	if (typeof packageConfig === 'object' && packageConfig.versions) {
		return packageConfig.versions;
	}
	if (Array.isArray(packageConfig) && packageConfig.length && packageConfig[0].versions) {
		return packageConfig.map((el) => el.versions.trim()).join(' || ');
	}
	assert.fail(`Unable to parse tested versions from tav config: ${util.inspect(config)}`);
};
const readJson = (...args) => {
	return readFile(...args).then(JSON.parse);
};
const eatError = (err) => {
	console.error(err);
	return null;
};
const getTestedVersions = (name, packageJson, tavConfig) => {
	assert.equal(typeof name, 'string');
	assert.equal(typeof tavConfig, 'object');
	assert.equal(typeof packageJson, 'object');
	assert.equal(util.types.isPromise(tavConfig), false);
	assert.equal(util.types.isPromise(packageJson), false);

	if (tavConfig) {
		const range = getTestedVersionsFromTavConfig(name, tavConfig);
		assert(semver.validRange(range), `Invalid range ${util.inspect(range)} for ${name}`);
		return range;
	}
	const devDepVersion = packageJson.devDependencies[name];
	if (devDepVersion) {
		return devDepVersion;
	}
	// TODO: check out why is fastfy included as dep rather than devdep
	const depVersion = packageJson.dependencies[name];
	if (name === 'fastify' && depVersion) {
		return depVersion;
	}
	assert.fail(`No tested version for ${name}`);
};

const loadFiles = async (pluginRoot) => {
	return {
		packageJson: await readJson(path.join(pluginRoot, 'package.json'))
			.catch(eatError),
		readme: await readFile(path.join(pluginRoot, 'README.md'), 'utf8')
			.catch(eatError),
	};
};

const loadPluginData = async (pluginRoot) => {
	const pkgJsonPath = path.join(pluginRoot, 'package.json');
	const files = await loadFiles(pluginRoot);
	if (!files.packageJson) {
		return { root: pluginRoot, files };
	}
	const tav = await checkTav(pluginRoot, files.packageJson);
	const instrumentationName = files.packageJson?.name;
	const name = should(instrumentationName, INSTRUMENTED_PACKAGE_NAME)
		? getInstrumentedPackageName(instrumentationName, files.readme)
		: undefined;

	const stats = name ? await fetchStats(name) : undefined;
	const supportedRange = should(instrumentationName, SUPPORTED_VERSIONS)
		? getSupportedVersions(files.readme) : undefined;

	// TODO: aws-sdk patches more than one package
	const testedRange = supportedRange && getTestedVersions(name, files.packageJson, tav.config);
	console.error(name, testedRange);
	// console.log('supported', await supportedRange);
	return {
		root: pluginRoot,
		files,
		name,
		instrumentationName,
		testedRange,
		// packageJson,
		supportedRange,
		tav,
		stats,
	};
};

export const loadPlugins = async (contribRoot) => {
	const dirs = await readdir(contribRoot);
	return Promise.all(
		dirs
			.map((dir) => {
				return loadPluginData(path.resolve(contribRoot, dir));
			})
	);
};
