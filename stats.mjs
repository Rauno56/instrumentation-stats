import { default as semver } from 'semver';
import * as util from 'util';
import { strict as assert } from 'assert';
import * as path from 'path';
import { readdir, readFile, access } from 'fs/promises';
import fetchStats, { filter as filterStats } from '../../npm-version-download-stats/src/index.js';
import { sumDownloads } from '../../npm-version-download-stats/src/utils.js';


const PLUGINS_DIR = '../opentelemetry-js-contrib/plugins/node/';
console.log('path.resolve()', path.resolve(PLUGINS_DIR));

const SUPPORTED_VERSIONS = Symbol('SUPPORTED_VERSIONS');
const INSTRUMENTED_PACKAGE_NAME = Symbol('INSTRUMENTED_PACKAGE_NAME');
const FETCH_STATS = Symbol('FETCH_STATS');
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
	const hasTavConfig = await fileExists(path.join(root, './.tav.yml'));
	const tavVersion = packageJson.devDependencies['test-all-versions'];
	const tavScript = packageJson.scripts['test-all-versions'];
	return {
		valid: !!(hasTavConfig && tavVersion && tavScript),
		hasTavConfig,
		tavVersion,
		tavScript,
	};
};
const readJson = (...args) => {
	return readFile(...args).then(JSON.parse);
};
const compileVersionStats = async (packageName, semverRange) => {
	assert.equal(typeof packageName, 'string');
	assert.equal(typeof semverRange, 'string');
	let stats = await fetchStats(packageName).catch((err) => {
		err.packageName = packageName;
		throw err;
	});

	const sum = sumDownloads(stats);
	stats = stats.map((entry) => {
			return {
				...entry,
				get 'ratio(%)'() {
					return round(100 * entry.downloads / sum, 1);
				}
			}
		});


	const subset = filterStats(stats, { semverRange, showDeprecated: true });
	const tableSum = sumDownloads(subset);

	return {
		sum,
		subsetSum: tableSum,
		supportedRatio: (100 * tableSum / sum).toFixed(2),
		stats,
	};
};
const plugins = await Promise.all(
	(await readdir(PLUGINS_DIR))
		// .slice(3, 5)
		.map(async (dir) => {
			const root = path.resolve(PLUGINS_DIR, dir);
			const pkgJsonPath = path.join(root, 'package.json');
			const packageJson = await readJson(path.join(root, 'package.json'))
				.catch((err) => {
					console.error(err);
					return null;
				});
			const instrumentationName = packageJson.name;
			const readme = readFile(path.join(root, 'README.md'), 'utf8')
				.catch((err) => {
					console.error(err);
					return null;
				});
			const supportedVersions = should(instrumentationName, SUPPORTED_VERSIONS)
				? readme.then(getSupportedVersions) : undefined;
			const tav = checkTav(root, packageJson);
			const name = should(instrumentationName, INSTRUMENTED_PACKAGE_NAME)
				? readme.then((readmeContents) => getInstrumentedPackageName(instrumentationName, readmeContents))
				: undefined;
			// TODO: aws-sdk patches more than one package
			const versionStats = supportedVersions && name && should(instrumentationName, FETCH_STATS)
				? Promise.all([name, supportedVersions]).then(([n, s]) => compileVersionStats(n, s))
					.catch(async (err) => {
						console.error(`Loading stats failed for ${await name}@${await supportedVersions}`);
						throw err;
					})
				: undefined;
			// console.log('supported', await supportedVersions);
			return {
				root,
				name: await name,
				versionStats: await versionStats,
				instrumentationName,
				// packageJson,
				supportedVersions: await supportedVersions,
				tav: await tav,
			};
		})
);

console.table(
	plugins
		// .slice(7, 11)
		.map(({ name, versionStats: { supportedRatio } = {}, tav: { valid: tavValid }, supportedVersions, ...el }) => {
			console.log('el', el);
			return {
				name,
				supportedRatio,
				tavValid,
			};
		})
);


