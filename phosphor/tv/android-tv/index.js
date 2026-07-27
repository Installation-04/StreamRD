/**
 * Entry point registered with the native host. When you generate the
 * android/ project from the react-native-tvos template (see README.md),
 * keep this file — or merge its registerComponent call into the
 * template's generated index.js — so the JS bundle name matches
 * MainActivity's getMainComponentName().
 */
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
