import { default as semver } from 'semver';
import * as util from 'util';
import { strict as assert } from 'assert';
import * as path from 'path';
import { readdir, readFile, access, writeFile } from 'fs/promises';
import fetchStats, { filter as filterStats } from '../../npm-version-download-stats/src/index.js';
import { sumDownloads } from '../../npm-version-download-stats/src/utils.js';
import yaml from 'js-yaml';
import { loadPlugins } from './plugins.js';

const PLUGINS_DIR = '../opentelemetry-js-contrib/plugins/node/';

const round = (val, dec = 0) => {
	const m = Math.pow(10, dec);
	return Math.round((val + Number.EPSILON) * m) / m;
};
const formatLarge = (nr) => {
	if (nr) {
		return nr.toLocaleString('en-US');
	}
	return '';
};
const formatLongRange = (semverRange) => {
	if (semverRange.length <= 10) {
		return semverRange;
	}
	const versions = semverRange
		.split(/\s*\|\|\s*/);
	if (versions.length <= 3) {
		return semverRange;
	}
	return `${versions.slice(0, 2).join(' || ')} + ${versions.length - 2} more`;
};

const compileVersionStats = (plugin) => {
	assert.equal(typeof plugin.name, 'string');
	if (!plugin.stats) {
		return consoe.log('no stats, skipping', plugin.name);
	}
	const { stats } = plugin;

	const sum = sumDownloads(stats);
	// stats = stats.map((entry) => {
	// 		return {
	// 			...entry,
	// 			get 'ratio(%)'() {
	// 				return round(100 * entry.downloads / sum, 1);
	// 			}
	// 		}
	// 	});

	const supported = plugin.supportedRange && subsetStats(stats, plugin.supportedRange) || null;
	// TODO: detect supported and tested sets overlap
	const tested = plugin.testedRange && subsetStats(stats, plugin.testedRange) || null;
	const testedSupported = supported && tested && subsetStats(supported.subset, plugin.testedRange) || null;

	return {
		stats,
		sum,
		supported,
		tested,
		testedSupported,
		supportedRatio: formatRatio(supported?.sum, sum),
		testedRatio: formatRatio(tested?.sum, sum),
		testedSupportedRatio: formatRatio(testedSupported?.sum, supported?.sum),
	};
};
const formatRatio = (part, whole) => {
	if (whole === undefined) {
		return undefined;
	}
	if (part === undefined) {
		return formatRatio(0, whole);
	}
	return round(100 * part / whole, 1);
};
const subsetStats = (stats, semverRange) => {
	const subset = filterStats(stats, { semverRange, showDeprecated: true });
	const sum = sumDownloads(subset);
	return {
		subset,
		sum,
	};
};
const writeJson = (file, data) => {
	return writeFile(file, JSON.stringify(data, null, 2));
};
const readJson = (...args) => {
	return readFile(...args).then(JSON.parse);
};
const mapValues = (obj, mapperFn) => {
	assert.equal(typeof obj, 'object');
	return Object.fromEntries(
		Object.entries(obj)
			.map(([key, value]) => {
				return [key, mapperFn([key, value])];
			})
	);
};
const getScriptobject = (scripts) => {
	return mapValues(scripts, () => true);
};
const enhance = {
	withCompiledStats: (plugin) => {
		if (plugin.name) {
			plugin.stats = compileVersionStats(plugin);
		}
		return plugin;
	},
	withScriptStats: (plugin) => {
		if (plugin?.files?.packageJson?.scripts) {
			plugin.scripts = getScriptobject(plugin?.files?.packageJson?.scripts);
			// console.error('scripts', plugin.name, plugin.scripts);
		} else {
			// console.error('no scripts for', plugin.name);
		}
		return plugin;
	}
};
const loadData = async (filename, reload = false) => {
	if (!reload) {
		return readJson(filename);
	}
	const data = (await loadPlugins(PLUGINS_DIR)).map(enhance.withCompiledStats)

	console.log(data);
	writeJson(filename, data)
		.then(() => console.log('File written.'));

	return data;
};

const reload = !true;
const filename = './data.json';

const plugins = await loadData(filename, reload);

const show = plugins
	.map(enhance.withScriptStats)
	.filter((item) => {
		return item.supportedRange;
	});

show.sort((a, b) => {
	assert(a.stats, `stats not loaded: ${util.inspect(a)}`);
	assert(b.stats, `stats not loaded: ${util.inspect(b)}`);
	return a.stats.sum < b.stats.sum ? 1 : -1;
});

console.table(
	show
		.map((item) => {
			// console.log(item);
			const {
				supportedRange,
				testedRange,
				name,
				stats: { supportedRatio, testedRatio, testedSupportedRatio, sum } = {},
				tav: { valid: tav },
				...el
			} = item;
			// console.error(name, item.scripts);
			return {
				name,
				sum: formatLarge(sum),
			};
		})
);

// console.table(
// 	show
// 		.map((item) => {
// 			// console.log(item);
// 			const {
// 				supportedRange,
// 				testedRange,
// 				name,
// 				stats: { supportedRatio, testedRatio, testedSupportedRatio, sum } = {},
// 				tav: { valid: tav },
// 				...el
// 			} = item;
// 			return {
// 				name,
// 				supportedRange,
// 				testedRange: formatLongRange(testedRange),
// 				'support%': supportedRatio,
// 				'test/support%': testedSupportedRatio,
// 				'test%': testedRatio,
// 				tav,
// 				sum: formatLarge(sum),
// 			};
// 		})
// );
