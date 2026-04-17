package com.example.smartgoprototype.notification

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.example.smartgoprototype.MainActivity
import com.example.smartgoprototype.R
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class DepartureAlarmReceiver : BroadcastReceiver() {

    companion object {
        const val EXTRA_ROUTE_TITLE   = "route_title"
        const val EXTRA_REASONING     = "reasoning"
        const val EXTRA_DEPART_TIME   = "depart_time"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val routeTitle     = intent.getStringExtra(EXTRA_ROUTE_TITLE) ?: return
        val reasoning      = intent.getStringExtra(EXTRA_REASONING).orEmpty()
        val departTime     = intent.getStringExtra(EXTRA_DEPART_TIME).orEmpty()
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)

        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val formattedTime = runCatching {
            Instant.parse(departTime)
                .atZone(ZoneId.systemDefault())
                .format(DateTimeFormatter.ofPattern("HH:mm"))
        }.getOrElse { "" }

        val bodyText = buildString {
            append("Depart in 5 minutes")
            if (formattedTime.isNotBlank()) append(" at $formattedTime")
            if (reasoning.isNotBlank()) append(" · $reasoning")
        }

        // Tapping the notification opens the dashboard
        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val tapPendingIntent = PendingIntent.getActivity(
            context,
            notificationId,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, NotificationHelper.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Time to leave: $routeTitle")
            .setContentText(bodyText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bodyText))
            .setContentIntent(tapPendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        NotificationManagerCompat.from(context).notify(notificationId, notification)
    }
}
