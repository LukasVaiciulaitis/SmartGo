package com.example.smartgoprototype.notification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

object NotificationHelper {

    const val CHANNEL_ID = "departure_reminders"

    fun createChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Departure Reminders",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Alerts you 5 minutes before your next scheduled departure"
            enableVibration(true)
        }
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }
}
