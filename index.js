import colors from 'ansi-colors';
import cliProgress from 'cli-progress';
import parseCSS from 'css-rules';
import fs from 'fs';
import jsdom from 'jsdom';
import fetch from 'node-fetch';
import { Timer } from 'timer-node';

const { JSDOM } = jsdom;
const SITEMAP_URL = "https://www.handelsbanken.se/tron/public/ui/configurations/v1/sitemap/sitemap?rev=280490&lang=sv";
const CSS_URL = "https://www.handelsbanken.se/sv/sepu//css/shb/app/style.css?rev=280490";
const BASE_URL = "https://www.handelsbanken.se/sv/"

const TIMINGS = [];
const INVALID = []

const timer = new Timer();

function timeToString(time, delimiter = ''){
    const prefix = Number(time).toString().length === 1 ? "0" : ""
    
    return time > 0 ? `${prefix}${time}${delimiter}` : `00${delimiter}`;
}

function secondsToHms(totalTime) {
    const HOUR_IN_SECONDS = 60 * 60;
    const hours = Math.floor(totalTime / HOUR_IN_SECONDS);
    const minutes = Math.floor(totalTime % HOUR_IN_SECONDS / 60);
    const seconds = Math.floor(totalTime % HOUR_IN_SECONDS % 60);

    return `${timeToString(hours, ":")}${timeToString(minutes, ":")}${timeToString(seconds)}`; 
}

const progress = new cliProgress.SingleBar({
    format: `${colors.cyan('{bar}')} {percentage}% | {value}/{total} views | Time -{timeLeft} | Selectors found: {result} | Url: {url}`,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
});

function toViewUrls(urls, { id, views = []}){
    if(id && !urls.includes(id)){
        urls.push(id)
    }
     
    return views.reduce(toViewUrls, urls)
}

function outNull(id){
    return Boolean(id)
}

function outDuplicates(id, index, self){
    return self.indexOf(id) === index;
}

function toCssObjects(acc, [ selector, props ]){
    acc.push({
        selector, props: getCSSProps(props)
    })

    return acc
}

function outTestViews(url){
    return !url.startsWith('test/')
}


function getCSSProps(item){
    return new Array(item.length)
        .fill('')
        .map((_, index) => item[index])
        .reduce((acc, prop) => { 
            acc[prop] = item[prop]; 
            return acc 
        }, {})
}

async function getCssObjects(){
    const cssResponse = await fetch(CSS_URL)
    const css = await cssResponse.text();
    const parsedCss = await parseCSS(css);

    return parsedCss.reduce(toCssObjects, [])
}

async function getViewUrls(){
    const response = await fetch(SITEMAP_URL)
    const sitemap = await response.json();

    return sitemap.views.reduce(toViewUrls, []).filter(outNull).filter(outTestViews).filter(outDuplicates);
}

function toSortedSelectors(acc, selector){
    const { document, selectors } = acc

    try{            
        if(document.querySelector(selector)){
            selectors.push(selector)
        }
    } catch(e){
        if(!INVALID.includes(selector)){
            INVALID.push(selector)
        }
    }

    return acc
}

async function getDom(url){
    progress.increment({
        url
    });

    try{
        const { window: { document} } = await JSDOM.fromURL(`${BASE_URL}${url}`);

        return document
    } catch {
        return undefined
    }
}

function getSelectorsFromDocument(document, selectors){
    const res =  selectors.reduce(toSortedSelectors, {
        document, 
        selectors: []
    })

    return res.selectors
}

async function getUsedSelectors(view, selectors) {
    const dom = await getDom(view)
    
    if(dom){
        return getSelectorsFromDocument(dom, selectors)
    }

    return []
}

function outSelectorDuplicates(selectors, selector){
    if(!selectors.includes(selector)){
        selectors.push(selector)
    }
    return selectors
}

async function toUsedSelectors(uniqeUsedSelectors, view, selectors){
    timer.start();
    const usedSelectors = await getUsedSelectors(view, selectors)
    timer.stop()
    TIMINGS.push(timer.ms());

    return usedSelectors.reduce(outSelectorDuplicates, uniqeUsedSelectors)
}

function toTotalTime(total, timing){
    total = total + timing
    
    return total
}

function getTimeLeft(index, numberOfItems){
    const totalTime = TIMINGS.reduce(toTotalTime, 0)
    const averageTime = totalTime / index
    const timeLeft = (averageTime * numberOfItems) - totalTime

    return secondsToHms((timeLeft / 1000))
}

async function analyzeCssUsage(views, selectors){
    return views.reduce(async (uniqeUsedSelectors, view, index) => {
        const resolvedArr = await uniqeUsedSelectors;
    
        const res = await toUsedSelectors(resolvedArr, view, selectors)
        progress.update({ timeLeft: getTimeLeft(index, views.length), result: Number(res.length).toString()})

        return res;
    }, [])
}

function toSelectors({ selector }){
    return selector
}

function asAlpabetical(stringA, stringB){
    if (stringA < stringB) {
        return -1;
    }
    if (stringA > stringB){
        return 1;
    }
    
    return 0; 
}

function getSelectorTypes(matchedSelectors, cssObjects){
    return {
        matchedSelectors: cssObjects.filter(({ selector }) => matchedSelectors.includes(selector)).map(toSelectors).sort(asAlpabetical),
        unMatchedSelector: cssObjects.filter(({ selector }) => !matchedSelectors.includes(selector)).map(toSelectors).sort(asAlpabetical),
    }
}

function toJSON(fileName, data){
    fs.writeFileSync(fileName, JSON.stringify(data, null, "\t"));
}

function toTxt(fileName, data){
    fs.writeFileSync(fileName, data);
}

function getSummary(selectors, views, {matchedSelectors, unMatchedSelector}, invalidSorted){
    return `
SUMMARY (${new Date().toLocaleDateString()})
- Total number of selectors: ${selectors.length}
- Total number of views: ${views.length}

- Selectors used: ${matchedSelectors.length}
- Selectors not used: ${unMatchedSelector.length}
- Selectors invalid: ${invalidSorted.length}

Script run for ${secondsToHms(TIMINGS.reduce(toTotalTime) / 1000)}
`    
}

async function run(){
    const views = await getViewUrls();
    const cssObjects = await getCssObjects()
    const selectors = cssObjects.map(toSelectors)
    progress.start(views.length, 0, {
        timeLeft: "N/A",
        result: "0"
    });
    const matchedSelectors = await analyzeCssUsage(views, selectors);
    progress.update({ timeLeft: '', url: ''})
    progress.stop();

    const sortedSelectors = getSelectorTypes(matchedSelectors, cssObjects)
    const invalidSorted = INVALID.filter(outDuplicates).sort(asAlpabetical)

    toJSON('results/views.json', views.sort(asAlpabetical));
    toJSON('results/used.json', sortedSelectors.matchedSelectors);
    toJSON('results/unused.json', sortedSelectors.unMatchedSelector);
    toJSON('results/invalid.json', invalidSorted);
    toTxt('results/summary.txt',  getSummary(selectors, views, sortedSelectors, invalidSorted));
}

run()