package com.example.smartgoprototype.notification

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.example.smartgoprototype.domain.model.ForecastDay
import com.example.smartgoprototype.domain.model.Route
import dagger.hilt.android.qualifiers.ApplicationContext
import java.time.DayOfWeek
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class NotificationScheduler @Inject constructor(
    @ApplicationContext private val context: Context
) {
    private val alarmManager = context.getSystemService(AlarmManager::class.java)

    companion object {
        private const val NOTIFY_BEFORE_MS = (24 * 60 + 21) * 60 * 1000L

        private val DAY_KEY_MAP = mapOf(
            DayOfWeek.MONDAY    to "MON",
            DayOfWeek.TUESDAY   to "TUE",
            DayOfWeek.WEDNESDAY to "WED",
            DayOfWeek.THURSDAY  to "THU",
            DayOfWeek.FRIDAY    to "FRI",
            DayOfWeek.SATURDAY  to "SAT",
            DayOfWeek.SUNDAY    to "SUN"
        )
    }

    /**
     * Cancels any existing alarms for the given routes, then schedules fresh alarms
     * for all upcoming active-day departures that are more than 5 minutes away.
     */
    fun scheduleAll(routes: List<Route>) {
        if (!canScheduleExact()) return
        cancelAll(routes)
        val now = Instant.now()

        routes
            .filter { it.userActive && it.forecast != null }
            .forEach { route ->
                val activeKeys = route.schedule.activeDays
                    .mapNotNull { DAY_KEY_MAP[it] }
                    .toSet()

                route.forecast!!.days
                    .filterKeys { it in activeKeys }
                    .forEach { (dayKey, forecastDay) ->
                        val departInstant = runCatching {
                            Instant.parse(forecastDay.recommendation.adjustedDepartBy)
                        }.getOrNull() ?: return@forEach

                        val alarmAt = departInstant.minusMillis(NOTIFY_BEFORE_MS)
                        if (alarmAt.isAfter(now)) {
                            scheduleAlarm(route, dayKey, forecastDay, alarmAt)
                        }
                    }
            }
    }

    /**
     * Cancels all scheduled alarms for the given routes.
     * Request codes are deterministic so PendingIntents can be reconstructed for cancellation.
     */
    fun cancelAll(routes: List<Route>) {
        routes.forEach { route ->
            DAY_KEY_MAP.values.forEach { dayKey ->
                val pi = makePendingIntent(
                    routeId = route.id,
                    dayKey = dayKey,
                    routeTitle = "",
                    reasoning = "",
                    departTime = "",
                    flags = PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
                )
                pi?.let { alarmManager.cancel(it) }
            }
        }
    }

    fun canScheduleExact(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()

    private fun scheduleAlarm(
        route: Route,
        dayKey: String,
        forecastDay: ForecastDay,
        alarmAt: Instant
    ) {
        val pi = makePendingIntent(
            routeId = route.id,
            dayKey = dayKey,
            routeTitle = route.title,
            reasoning = forecastDay.recommendation.reasoning,
            departTime = forecastDay.recommendation.adjustedDepartBy,
            flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        ) ?: return

        alarmManager.setExactAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP,
            alarmAt.toEpochMilli(),
            pi
        )
    }

    private fun makePendingIntent(
        routeId: String,
        dayKey: String,
        routeTitle: String,
        reasoning: String,
        departTime: String,
        flags: Int
    ): PendingIntent? {
        val requestCode = (routeId + "|" + dayKey).hashCode()
        val intent = Intent(context, DepartureAlarmReceiver::class.java).apply {
            putExtra(DepartureAlarmReceiver.EXTRA_ROUTE_TITLE, routeTitle)
            putExtra(DepartureAlarmReceiver.EXTRA_REASONING, reasoning)
            putExtra(DepartureAlarmReceiver.EXTRA_DEPART_TIME, departTime)
            putExtra(DepartureAlarmReceiver.EXTRA_NOTIFICATION_ID, requestCode)
        }
        return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }
}
