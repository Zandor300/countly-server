/*global countlyVue, countlyDashboards, CV */

(function() {
    var BarChartComponent = countlyVue.views.create({
        template: CV.T('/dashboards/templates/widgets/bar-chart.html'),
        props: {
            data: {
                type: Object,
                default: function() {
                    return {};
                }
            }
        }
    });

    var DrawerComponent = countlyVue.views.create({
        template: "<div>{{scope.editedObject.widget_type}}</div>",
        props: {
            scope: {
                type: Object,
                default: function() {
                    return {};
                }
            }
        }
    });

    countlyVue.container.registerData("/custom/dashboards/widget", {
        type: "bar-chart",
        label: CV.i18nM("dashboards.bar-chart"),
        priority: 2,
        dimensions: function() {
            return {
                minWidth: 6,
                minHeight: 2,
                width: 6,
                height: 3
            };
        },
        gridComponent: BarChartComponent,
        drawerComponent: DrawerComponent
    });
})();