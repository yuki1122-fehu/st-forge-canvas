/**
 * 变量斜杠命令与宏替换 — 独立插件精简版
 * 仅提供画图模块所需的 two functions
 */
import { getContext } from "../../../../../extensions.js";

const TAG_RE_XBGETVAR = /\{\{xbgetvar::([^}]+)\}\}/gi;
const TAG_RE_XBGETVAR_YAML = /\{\{xbgetvar_yaml::([^}]+)\}\}/gi;

function lwbResolveVarPath(path) {
    try {
        const ctx = getContext();
        if (!ctx?.getVariable) return '';
        const segs = path.trim().split('.');
        if (!segs.length) return '';
        let value = ctx.getVariable(segs[0]);
        if (segs.length === 1) return String(value ?? '');
        for (let i = 1; i < segs.length; i++) {
            if (value === null || value === undefined) return '';
            value = value[segs[i]];
        }
        return String(value ?? '');
    } catch { return ''; }
}

export function replaceXbGetVarInString(s) {
    s = String(s ?? '');
    if (!s || s.indexOf('{{xbgetvar::') === -1) return s;
    TAG_RE_XBGETVAR.lastIndex = 0;
    return s.replace(TAG_RE_XBGETVAR, (_, p) => lwbResolveVarPath(p));
}

export function replaceXbGetVarYamlInString(s) {
    s = String(s ?? '');
    if (!s || s.indexOf('{{xbgetvar_yaml::') === -1) return s;
    TAG_RE_XBGETVAR_YAML.lastIndex = 0;
    return s.replace(TAG_RE_XBGETVAR_YAML, (_, p) => {
        const value = lwbResolveVarPath(p);
        return value || '';
    });
}
